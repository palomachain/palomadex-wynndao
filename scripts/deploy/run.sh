#!/bin/bash

SCRIPT_DIR="$(realpath "$(dirname "$0")")"

if [[ -z "${MNEMONIC}" ]]; then
  echo "MNEMONIC env has not been set!" 1>&2
  exit 1
fi

npm install
npm run deploy
