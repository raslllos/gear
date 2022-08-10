#!/bin/bash
#
# Generate and update gear-node api.

readonly ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
readonly GEAR_NODE_DOCKER_IMAGE='ghcr.io/gear-tech/node:latest'
readonly GEAR_NODE_BIN='/usr/local/bin/gear-node'
readonly GENERATED_RS="${ROOT_DIR}/src/api/generated.rs"
readonly RPC_PORT='9933'

#################
# Generated header
###################
function generate-header() {
    cat <<EOF
//! Auto generated by subxt-cli
//!
//! subxt codegen | rustfmt --edition=2021
//!
//! spec_version: $1
#![allow(clippy::all)]
EOF
}

######################
# Usage of this script.
########################
function usage() {
    cat 1>&2 <<EOF
generate-api
Generate gear-node api.

USAGE:
    generate-api
EOF
}

#############################################################
# Check if the required binaries are installed in the machine.
###############################################################
function pre-check() {
    if ! [ -x "$(command -v docker)" ]; then
        echo 'command docker not found.';
        exit 1
    fi

    if ! [ -x "$(command -v cargo)" ]; then
        echo 'cargo not found, installing rust...';
        curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
    fi

    if ! [ -x "$(command -v subxt)" ]; then
        echo 'subxt not found, installing subxt...';
        cargo install subxt-cli
    fi

    if ! [ -x "$(command -v rustfmt)" ]; then
        echo 'rustfmt not found, installing rustfmt...';
        rustup component add rustfmt
    fi
}


##########################
# Run gear-node with docker.
############################
function gear-node() {
    docker run -p ${RPC_PORT}:${RPC_PORT} -d \
           ${GEAR_NODE_DOCKER_IMAGE} ${GEAR_NODE_BIN} \
           --tmp --dev --rpc-port ${RPC_PORT} --unsafe-rpc-external
}

#########################################
# Generate rust code for the gear-node api.
############################################
function main() {
    if [ "$#" -ne 0 ]; then
        usage
        exit 0
    fi

    # 0. Check if the required commands exist.
    pre-check

    # 1. Run gear-node with docker.
    docker pull "${GEAR_NODE_DOCKER_IMAGE}" >&2
    pid=$(gear-node)

    # 2. Get spec version from node logs.
    spec_version=''
    while [ ${#spec_version} -eq 0 ]; do
        sleep 1
        spec_version="$(docker logs ${pid} 2>&1 | grep -Eo 'gear-node-[0-9]{4}' | sed 's/.*-//')"
    done

    generate-header "${spec_version}" > "${GENERATED_RS}"
    subxt codegen --url "http://0.0.0.0:${RPC_PORT}" | rustfmt --edition=2021 >> "${GENERATED_RS}"

    docker kill "${pid}" &> /dev/null

    echo "Updated gear-node api in ${GENERATED_RS}." >&2
    exit 0
}

main "$@"
