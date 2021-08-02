/* eslint-disable no-restricted-syntax */
/* eslint-disable no-console */
/* eslint-disable max-len */
// Required imports
const {
  ApiPromise,
  WsProvider,
} = require('@polkadot/api');
const { xxhashAsHex, blake2AsU8a } = require('@polkadot/util-crypto');

// import the test keyring (already has dev keys for Alice, Bob, Charlie, Eve & Ferdie)
const testKeyring = require('@polkadot/keyring/testing');
const fs = require('fs');

function xxKey(module, key) {
  return xxhashAsHex(module, 128) + xxhashAsHex(key, 128).slice(2);
}

async function resetStorage(api, sudoPair) {
  const keys = [];
  const txs = [];
  let hash = xxKey('Gear', 'DequeueLimit');
  keys.push(hash);

  hash = xxKey('Gear', 'MessageQueue');
  keys.push(hash);

  hash = xxKey('Gear', 'MessagesProcessed');
  keys.push(hash);
  txs.push(api.tx.sudo.sudo(
    api.tx.system.killStorage(
      keys,
    ),
  ));
  txs.push(api.tx.sudo.sudo(
    api.tx.system.killPrefix(
      'g::', 1,
    ),
  ));

  await api.tx.utility.batch(txs).signAndSend(sudoPair, { nonce: -1 });
  let head = await api.rpc.state.getStorage('g::msg::head');
  while (head.isSome) {
    head = await api.rpc.state.getStorage('g::msg::head');
  }
}

function generateProgramId(api, path, salt) {
  const binary = fs.readFileSync(path);

  const code = api.createType('Bytes', Array.from(binary));
  const codeArr = api.createType('Vec<u8>', code).toU8a();
  const saltArr = api.createType('Vec<u8>', salt).toU8a();

  const id = new Uint8Array(codeArr.length + saltArr.length);
  id.set(codeArr);
  id.set(saltArr, codeArr.length);

  return api.createType('H256', blake2AsU8a(id, 256)).toHex();
}

async function checkMessages(api, exp, programs) {
  const errors = [];
  const messageQueue = [];
  if (exp.messages.length === 0) {
    return errors;
  }

  let head = await api.rpc.state.getStorage('g::msg::head');

  if (head.isSome) {
    head = api.createType('H256', head.unwrap());
  } else {
    errors.push('Unable to get a message queue');
    return errors;
  }

  let node = await api.rpc.state.getStorage(`0x${Buffer.from('g::msg::').toString('hex')}${head.toHex().slice(2)}`);
  node = api.createType('Node', node.unwrap());
  messageQueue.push(node.value);

  while (node.next.isSome) {
    node = await api.rpc.state.getStorage(`0x${Buffer.from('g::msg::').toString('hex')}${node.next.toHex().slice(2)}`);
    node = api.createType('Node', node.unwrap());
    messageQueue.push(node.value);
  }

  if (messageQueue.length !== exp.messages.length) {
    errors.push('Messages count does not match');
    return errors;
  }

  for (let index = 0; index < messageQueue.length; index++) {
    const message = api.createType('Message', messageQueue[index]);
    const expMessage = exp.messages[index];

    let payload = false;
    if (expMessage.payload) {
      if (expMessage.payload.kind === 'bytes') {
        payload = api.createType('Bytes', expMessage.payload.value);
      } else if (expMessage.payload.kind === 'i32') {
        payload = api.createType('Bytes', Array.from(api.createType('i32', expMessage.payload.value).toU8a()));
      } else if (expMessage.payload.kind === 'i64') {
        payload = api.createType('Bytes', Array.from(api.createType('i64', expMessage.payload.value).toU8a()));
      } else if (expMessage.payload.kind === 'f32') {
        payload = api.createType('Bytes', Array.from(api.createType('f32', expMessage.payload.value).toU8a()));
      } else if (expMessage.payload.kind === 'f64') {
        payload = api.createType('Bytes', Array.from(api.createType('f64', expMessage.payload.value).toU8a()));
      } else if (expMessage.payload.kind === 'utf-8') {
        payload = Buffer.from(expMessage.payload.value, 'utf8');
      }
    }

    if (payload && !message.payload.eq(payload)) {
      errors.push("Message payload doesn't match");
    }
    if (!message.dest.eq(programs[expMessage.destination])) {
      errors.push("Message destination doesn't match");
    }
    if ('gas_limit' in expMessage) {
      if (!message.gas_limit.toNumber().eq(expMessage.gas_limit)) {
        errors.push("Message gas_limit doesn't match");
      }
    }
  }

  return errors;
}

async function checkMemory(api, exp) {
  const errors = [];

  for (const mem of exp.memory) {
    if (mem.kind === 'shared') {
      const gearMemoryOpt = await api.rpc.state.getStorage('g::memory');
      const gearMemory = gearMemoryOpt.unwrap().toU8a();
      const at = parseInt(mem.at, 16) - (256 * 65536);
      const bytes = Uint8Array.from(Buffer.from(mem.bytes.slice(2), 'hex'));
      for (let index = at; index < at + bytes.length; index++) {
        if (gearMemory[index] !== bytes[index - at]) {
          errors.push("Memory doesn't match");
          break;
        }
      }
    }
  }
  return errors;
}

function submitProgram(api, sudoPair, program, salt, programs) {
  const binary = fs.readFileSync(program.path);

  let initMessage = [];
  if (program.init_message !== undefined) {
    if (program.init_message.kind === 'bytes') {
      initMessage = api.createType('Bytes', program.init_message.value);
    } else if (program.init_message.kind === 'i32') {
      initMessage = api.createType('Bytes', Array.from(api.createType('i32', program.init_message.value).toU8a()));
    } else if (program.init_message.kind === 'i64') {
      initMessage = api.createType('Bytes', Array.from(api.createType('i64', program.init_message.value).toU8a()));
    } else if (program.init_message.kind === 'f32') {
      initMessage = api.createType('Bytes', Array.from(api.createType('f32', program.init_message.value).toU8a()));
    } else if (program.init_message.kind === 'f64') {
      initMessage = api.createType('Bytes', Array.from(api.createType('f64', program.init_message.value).toU8a()));
    } else if (program.init_message.kind === 'utf-8') {
      if (program.init_message.value.search(/{([0-9]*)\}/) !== -1) {
        const res = program.init_message.value.match(/{([0-9]*)\}/);
        const id = Number(res[1]);
        if (programs[id] !== undefined) {
          program.init_message.value = program.init_message.value.replace(res[0], programs[id].toString().slice(2));
        }
      }
      initMessage = program.init_message.value;
    } else {
      initMessage = program.init_message.value;
    }
  }
  return api.tx.gear.submitProgram(api.createType('Bytes', Array.from(binary)), salt, initMessage, 1000000000, 0);
}

async function processExpected(api, sudoPair, fixture, programs) {
  const output = [];
  const errors = [];

  for (let expIdx = 0; expIdx < fixture.expected.length; expIdx++) {
    const exp = fixture.expected[expIdx];
    if ('step' in exp) {
      let deqLimit = await api.query.gear.dequeueLimit();
      while (deqLimit.isNone) {
        deqLimit = await api.query.gear.dequeueLimit();
      }
      if (deqLimit.unwrap().toNumber() !== exp.step) {
        const tx = [];

        // Set DequeueLimit
        const hash = xxKey('Gear', 'DequeueLimit');

        tx.push(api.tx.sudo.sudo(
          api.tx.system.setStorage([[hash, api.createType('Option<u32>', api.createType('u32', exp.step)).toHex()]]),
        ));

        await api.tx.utility.batch(tx).signAndSend(sudoPair, { nonce: -1 });
      }

      let messagesProcessed = await api.query.gear.messagesProcessed();

      // TODO: fix forever waiting
      // can wait forever if steps in expected parameter are higher than the actual processed messages
      while (messagesProcessed.toNumber() !== exp.step) {
        messagesProcessed = await api.query.gear.messagesProcessed();
      }

      if ('messages' in exp) {
        const res = await checkMessages(api, exp, programs);
        if (res.length === 0) {
          output.push('MSG: OK');
        } else {
          errors.push(`MSG ERR: ${res}`);
        }
      }

      if ('memory' in exp) {
        const res = await checkMemory(api, exp);
        if (res.length === 0) {
          output.push('MEMORY: OK');
        } else {
          errors.push(`MEMORY ERR: ${res}`);
        }
      }
    }
    // TODO: FIX IF NO STEPS
  }
  if (errors.length > 0) {
    console.log(`Fixture ${fixture.title}`);
    for (const err of errors) {
      console.log(err);
    }
    process.exit(1);
  }
  return output;
}

async function processFixture(api, sudoPair, fixture, programs) {
  const txs = [];

  if ('step' in fixture.expected[0]) {
    // Set DequeueLimit
    const hash = xxKey('Gear', 'DequeueLimit');
    await api.tx.sudo.sudo(
      api.tx.system.setStorage([[hash, api.createType('Option<u32>', api.createType('u32', fixture.expected[0].step)).toHex()]]),
    ).signAndSend(sudoPair, { nonce: -1 });
  }

  // Send messages
  for (let index = 0; index < fixture.messages.length; index++) {
    const message = fixture.messages[index];
    let msg = [];
    if (message.payload.kind === 'bytes') {
      msg = api.createType('Bytes', message.payload.value);
    } else if (message.payload.kind === 'i32') {
      msg = api.createType('Bytes', Array.from(api.createType('i32', message.payload.value).toU8a()));
    } else if (message.payload.kind === 'i64') {
      msg = api.createType('Bytes', Array.from(api.createType('i64', message.payload.value).toU8a()));
    } else if (message.payload.kind === 'f32') {
      msg = api.createType('Bytes', Array.from(api.createType('f32', message.payload.value).toU8a()));
    } else if (message.payload.kind === 'f64') {
      msg = api.createType('Bytes', Array.from(api.createType('f64', message.payload.value).toU8a()));
    } else if (message.payload.kind === 'utf-8') {
      if (message.payload.value.search(/{([0-9]*)\}/) !== -1) {
        const res = message.payload.value.match(/{([0-9]*)\}/);
        const id = Number(res[1]);
        if (programs[id] !== undefined) {
          message.payload.value = message.payload.value.replace(res[0], programs[id].toString().slice(2));
        }
      }
      msg = message.payload.value;
    } else {
      msg = message.payload.value;
    }
    txs.push(api.tx.gear.sendMessage(programs[message.destination], msg, 1000000000, 0));
  }

  await api.tx.utility.batch(txs).signAndSend(sudoPair, { nonce: -1 });

  return processExpected(api, sudoPair, fixture, programs);
}

async function processTest(test, api, sudoPair) {
  const programs = [];
  const salts = [];
  const txs = [];
  // Submit programs
  for (const fixture of test.fixtures) {
    const reset = await resetStorage(api, sudoPair);
    for (const program of test.programs) {
      const salt = Math.random().toString(36).substring(7);
      programs[program.id] = generateProgramId(api, program.path, salt);
      salts[program.id] = salt;
    }
    for (const program of test.programs) {
      const submit = submitProgram(api, sudoPair, program, salts[program.id], programs);
      txs.push(submit);
    }

    await api.tx.utility.batch(txs).signAndSend(sudoPair, { nonce: -1 });

    const out = await processFixture(api, sudoPair, fixture, programs);
    if (out.length > 0) {
      console.log(`Fixture ${fixture.title}: Ok`);
    }
  }
}

async function main() {
  const tests = [];

  // Load json files
  process.argv.slice(2).forEach((path) => {
    const fileContents = fs.readFileSync(path, 'utf8');

    try {
      const data = JSON.parse(fileContents);
      tests.push(data);
    } catch (err) {
      console.error(err);
    }
  });

  const totalFixtures = tests.reduce((tot, test) => tot + test.fixtures.length, 0);

  console.log('Total fixtures:', totalFixtures);

  // Initialise the provider to connect to the local node
  const provider = new WsProvider('ws://127.0.0.1:9944');

  // Create the API and wait until ready
  const api = await ApiPromise.create({
    provider,
    types: {
      Message: {
        id: 'H256',
        source: 'H256',
        dest: 'H256',
        payload: 'Vec<u8>',
        gas_limit: 'u64',
        value: 'u128',
        reply: 'Option<H256>',
      },
      Node: {
        value: 'Message',
        next: 'Option<H256>',
      },
      IntermediateMessage: {
        _enum: {
          InitProgram: {
            external_origin: 'H256',
            program_id: 'H256',
            code: 'Vec<u8>',
            payload: 'Vec<u8>',
            gas_limit: 'u64',
            value: 'u128',
          },
          DispatchMessage: {
            id: 'H256',
            route: 'MessageRoute',
            payload: 'Vec<u8>',
            gas_limit: 'u64',
            value: 'u128',
          },
        },
      },
      MessageError: {
        _enum: ['ValueTransfer', 'Dispatch'],
      },
    },
  });

  // Retrieve the upgrade key from the chain state
  const adminId = await api.query.sudo.key();

  // Find the actual keypair in the keyring (if this is a changed value, the key
  // needs to be added to the keyring before - this assumes we have defaults, i.e.
  // Alice as the key - and this already exists on the test keyring)
  const keyring = testKeyring.createTestKeyring();
  const adminPair = keyring.getPair(adminId.toString());

  for (const test of tests) {
    await processTest(test, api, adminPair);
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(() => process.exit());