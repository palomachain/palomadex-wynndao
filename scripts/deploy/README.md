## PALOMADEX deploy script

### Requirements

npm, nodejs

### How to use

Check if configuration files in `configs` directory is correct.
When you run launch script:

```bash
$ ./run.sh
```

it will check checksums of the contracts, then will proceed to store necessary wasm binaries.

In the middle process will stop, and user must update `configs/factory_config.json` file with newly uploaded binaries ID.

All necessary output is stored in `result.json` file.
