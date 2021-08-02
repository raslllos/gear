//! Wasmtime environment for running a module.

use wasmtime::{Engine, Extern, Func, Instance, Module, Store, Trap};

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use super::memory::MemoryWrap;

use gear_core::env::{Ext, LaterExt};
use gear_core::memory::{Memory, PageBuf, PageNumber};

use crate::funcs;

/// Environment to run one module at a time providing Ext.
pub struct Environment<E: Ext + 'static> {
    store: wasmtime::Store,
    ext: LaterExt<E>,
    funcs: BTreeMap<&'static str, Func>,
}

impl<E: Ext + 'static> Environment<E> {
    /// New environment.
    ///
    /// To run actual function with provided external environment, `setup_and_run` should be used.
    pub fn new() -> Self {
        let mut result = Self {
            store: Store::default(),
            ext: LaterExt::new(),
            funcs: BTreeMap::new(),
        };

        result.add_func_i32_to_u32("alloc", funcs::alloc);
        result.add_func_i32("free", funcs::free);
        result.add_func_i32("gas", funcs::gas);
        result.add_func_i32("gr_commit", funcs::commit);
        result.add_func_i64("gr_charge", funcs::charge);
        result.add_func_i32_i32("gr_debug", funcs::debug);
        result.add_func_i32_i32_i32_i64_i32_to_i32("gr_init", funcs::init);
        result.add_func_i32("gr_msg_id", funcs::msg_id);
        result.add_func_i32_i32_i32("gr_push", funcs::push);
        result.add_func_i32_i32("gr_push_reply", funcs::push_reply);
        result.add_func_i32_i32_i32("gr_read", funcs::read);
        result.add_func_i32_i32_i64_i32("gr_reply", funcs::reply);
        result.add_func_i32("gr_reply_to", funcs::reply_to);
        result.add_func_i32_i32_i32_i64_i32("gr_send", funcs::send);
        result.add_func_to_i32("gr_size", funcs::size);
        result.add_func_i32("gr_source", funcs::source);
        result.add_func_i32("gr_value", funcs::value);

        result
    }

    /// Setup external environment and run closure.
    ///
    /// Setup external environment by providing `ext`, run nenwly initialized instance created from
    /// provided `module`, do anything inside a `func` delegate.
    ///
    /// This will also set the beginning of the memory region to the `static_area` content _after_
    /// creatig instance.
    pub fn setup_and_run(
        &mut self,
        ext: E,
        binary: &[u8],
        memory_pages: &BTreeMap<PageNumber, Box<PageBuf>>,
        memory: &dyn Memory,
        entry_point: &str,
    ) -> (anyhow::Result<()>, E) {
        let module = Module::new(self.store.engine(), binary).expect("Error creating module");

        self.ext.set(ext);

        let result = self.run_inner(module, memory_pages, memory, move |instance| {
            instance
                .get_func(entry_point)
                .ok_or_else(|| {
                    anyhow::format_err!("failed to find `{}` function export", entry_point)
                })
                .and_then(|entry_func| entry_func.call(&[]))
                .map(|_| ())
        });

        let ext = self.ext.unset();

        (result, ext)
    }

    /// Return engine used by this environment.
    pub fn engine(&self) -> &Engine {
        self.store.engine()
    }

    /// Create memory inside this environment.
    pub fn create_memory(&self, total_pages: u32) -> MemoryWrap {
        MemoryWrap::new(
            wasmtime::Memory::new(
                &self.store,
                wasmtime::MemoryType::new(wasmtime::Limits::at_least(total_pages)),
            )
            .expect("Create env memory fail"),
        )
    }

    fn run_inner(
        &mut self,
        module: Module,
        memory_pages: &BTreeMap<PageNumber, Box<PageBuf>>,
        memory: &dyn Memory,
        func: impl FnOnce(Instance) -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        let mut imports = module
            .imports()
            .map(|import| {
                if import.module() != "env" {
                    Err(anyhow::anyhow!("Non-env imports are not supported"))
                } else {
                    Ok((import.name(), Option::<Extern>::None))
                }
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        for (ref import_name, ref mut ext) in imports.iter_mut() {
            if let Some(name) = import_name {
                *ext = match *name {
                    "memory" => {
                        let mem: &wasmtime::Memory =
                            match memory.as_any().downcast_ref::<wasmtime::Memory>() {
                                Some(mem) => mem,
                                None => panic!("Memory is not wasmtime::Memory"),
                            };
                        Some(wasmtime::Extern::Memory(Clone::clone(mem)))
                    }
                    key if self.funcs.contains_key(key) => Some(self.funcs[key].clone().into()),
                    _ => continue,
                }
            }
        }

        let externs = imports
            .into_iter()
            .map(|(_, host_function)| {
                host_function.ok_or_else(|| anyhow::anyhow!("Missing import"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        let instance = Instance::new(&self.store, &module, &externs)?;

        // Set module memory.
        memory
            .set_pages(memory_pages)
            .map_err(|e| anyhow::anyhow!("Can't set module memory: {:?}", e))?;

        func(instance)
    }

    fn add_func_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap1(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32, i32) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap2(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_i32_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32, i32, i32) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap3(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_i32_i32_i64_i32_to_i32<F>(
        &mut self,
        key: &'static str,
        func: fn(LaterExt<E>) -> F,
    ) where
        F: 'static + Fn(i32, i32, i32, i64, i32) -> Result<i32, &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap5(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_i32_i32_i64_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32, i32, i32, i64, i32) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap5(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_i32_i64_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32, i32, i64, i32) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap4(func(self.ext.clone()))),
        );
    }

    fn add_func_i32_to_u32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i32) -> Result<u32, &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap1(func(self.ext.clone()))),
        );
    }

    fn add_func_i64<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn(i64) -> Result<(), &'static str>,
    {
        self.funcs.insert(
            key,
            Func::wrap(&self.store, Self::wrap1(func(self.ext.clone()))),
        );
    }

    fn add_func_to_i32<F>(&mut self, key: &'static str, func: fn(LaterExt<E>) -> F)
    where
        F: 'static + Fn() -> i32,
    {
        self.funcs
            .insert(key, Func::wrap(&self.store, func(self.ext.clone())));
    }

    fn wrap1<T, R>(func: impl Fn(T) -> Result<R, &'static str>) -> impl Fn(T) -> Result<R, Trap> {
        move |a| func(a).map_err(Trap::new)
    }

    fn wrap2<T0, T1, R>(
        func: impl Fn(T0, T1) -> Result<R, &'static str>,
    ) -> impl Fn(T0, T1) -> Result<R, Trap> {
        move |a, b| func(a, b).map_err(Trap::new)
    }

    fn wrap3<T0, T1, T2, R>(
        func: impl Fn(T0, T1, T2) -> Result<R, &'static str>,
    ) -> impl Fn(T0, T1, T2) -> Result<R, Trap> {
        move |a, b, c| func(a, b, c).map_err(Trap::new)
    }

    fn wrap4<T0, T1, T2, T3, R>(
        func: impl Fn(T0, T1, T2, T3) -> Result<R, &'static str>,
    ) -> impl Fn(T0, T1, T2, T3) -> Result<R, Trap> {
        move |a, b, c, d| func(a, b, c, d).map_err(Trap::new)
    }

    fn wrap5<T0, T1, T2, T3, T4, R>(
        func: impl Fn(T0, T1, T2, T3, T4) -> Result<R, &'static str>,
    ) -> impl Fn(T0, T1, T2, T3, T4) -> Result<R, Trap> {
        move |a, b, c, d, e| func(a, b, c, d, e).map_err(Trap::new)
    }
}

impl<E: Ext + 'static> Default for Environment<E> {
    /// Creates a default environment.
    fn default() -> Self {
        Self::new()
    }
}