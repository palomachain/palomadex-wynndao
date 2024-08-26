#!/usr/bin/env -S yarn node

/* eslint-disable @typescript-eslint/naming-convention */
const { assertIsBroadcastTxSuccess, SigningCosmWasmClient, CosmWasmClient } = require("@cosmjs/cosmwasm-stargate");
const { DirectSecp256k1HdWallet } = require("@cosmjs/proto-signing");
const { stringToPath } = require("@cosmjs/crypto");
const { GasPrice, calculateFee } = require("@cosmjs/stargate");

const {env} = require("process");

const fs = require("fs");
const stdio = require("stdio");

const factoryConfigPath = "configs/factory_config.json";
const palomaConfigPath = "configs/paloma_config.json";
const multiHopConfigPath = "configs/multi_hop_config.json";
const gaugesConfigPath = "configs/gauges_config.json";

const factoryWasmPath = "/contracts/wyndex_factory.wasm";
const gaugeAdapterWasmPath = "/contracts/gauge_adapter.wasm";
const gaugeOrchestratorWasmPath = "/contracts/gauge_orchestrator.wasm";
const multiHopWasmPath = "/contracts/wyndex_multi_hop.wasm";
const pairWasmPath = "/contracts/wyndex_pair.wasm";
const pairStableWasmPath = "/contracts/wyndex_pair_stable.wasm";
const stakeWasmPath = "/contracts/wyndex_stake.wasm";
const tokenWasmPath = "/contracts/cw20_base.wasm";
const daoCoreWasmPath = "/contracts/dao_core.wasm";
const proposalSingleWasmPath = "/contracts/proposal_single.wasm";
const cw4StakeWasmPath = "/contracts/cw4_stake.wasm";

// Check "MNEMONIC" env variable and ensure it is set to a reasonable value
function getMnemonic() {
    const mnemonic = env["MNEMONIC"];
    if (!mnemonic || mnemonic.length < 48) {
        throw new Error("Must set MNEMONIC to a 12 word phrase");
    }
    return mnemonic;
}

async function connect(mnemonic, palomaConfig) {
    const { prefix, gasPrice, feeToken, rpcEndpoint } = palomaConfig;
    const hdPath = stringToPath("m/44'/118'/0'/0/0");

    // Setup signer
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix, hdPaths: [hdPath] });
    const [firstAccount] = await wallet.getAccounts();
    const address = firstAccount.address;
    console.info(`Connected to ${address}`);

    // Init SigningCosmWasmClient client
    try {
        const client = await SigningCosmWasmClient.connectWithSigner(rpcEndpoint, wallet, { gasPrice: GasPrice.fromString(gasPrice) });
        const balance = await client.getBalance(address, feeToken);
        console.info(`Balance: ${balance.amount} ${balance.denom}\n`);

        const chainId = await client.getChainId();
        console.info(`Chain ID: ${chainId}`);

        if (chainId !== palomaConfig.chainId) {
            throw new Error("Given ChainId doesn't match the client's ChainID!");
        }

        return { client, address };
    } catch (error) {
        console.error("Error during connectWithSigner:", error.message);
        throw error;
    }
}

async function storeContract(client, wallet, gasPriceS, label, wasmPath) {
    console.info('Storing ' + label + '...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const uploadFee = calculateFee(5_000_000, gasPrice);

    const wasmBinary = fs.readFileSync(__dirname + wasmPath);
    try {
        const uploadReceipt = await client.upload(
            wallet,
            wasmBinary,
            uploadFee,
            "Upload " + label + " contract",
        );
        console.info(label + " uploaded successfully. Receipt:\n" + JSON.stringify(uploadReceipt) + '\n');

        return uploadReceipt.codeId;
    } catch (error) {
        if (error.message.includes("Invalid string. Length must be a multiple of 4")) {
            console.warn("Warning: Ignoring the base64 error for " + label + ": " + error.message);
            console.warn(`error: {}`, error);
            // Continue execution or handle differently as needed
            // Returning the codeId if it's present in the error response
            const uploadReceipt = error.response?.uploadReceipt;
            if (uploadReceipt && uploadReceipt.codeId) {
                console.info(label + " uploaded with warnings. Receipt:\n" + JSON.stringify(uploadReceipt) + '\n');
                return uploadReceipt.codeId;
            }
        } else {
            throw error; // Re-throw other errors
        }
    }
}

async function instantiateContract(client, wallet, gasPriceS, config, codeId) {
    console.info('Instantiating ' + config.label + '...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const instantiateFee = calculateFee(500_000, gasPrice);

    try {
        const {contractAddress} = await client.instantiate(
            wallet,
            codeId,
            config.instantiate,
            config.label,
            instantiateFee,
            {
                memo: "Instantiation " + config.label,
                admin: wallet,
            },
        );
        console.info(config.label + ` contract instantiated at ${contractAddress}\n`);
        return contractAddress;
    } catch (error) {
        if (error.message.includes("Invalid string. Length must be a multiple of 4")) {
            console.warn("Warning: Ignoring the base64 error during instantiation of " + config.label + ": " + error.message);
            console.warn(`error: {}`, error);
            // Continue execution or handle differently as needed
            const uploadReceipt = error.response?.uploadReceipt;
            if (uploadReceipt && uploadReceipt.codeId) {
                console.info(label + " uploaded with warnings. Receipt:\n" + JSON.stringify(uploadReceipt) + '\n');
                return uploadReceipt.codeId;
            }
        } else {
            throw error; // Re-throw other errors
        }
    }
}

async function createPairsAndDistributionFlows(client, wallet, gasPriceS, config, factoryAddress) {
    console.info('Executing CreatePairAndDistributionFlows message...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const executeFee = calculateFee(1_500_000, gasPrice);

    let pairs = [];

    for (let i = 0; i < config.create_pairs.length; i++) {
        const result = await client.execute(
            wallet,
            factoryAddress,
            config.create_pairs[i],
            executeFee
        );

        // Correctly filter the wasm events
        const wasmEvents = result.events.filter((e) => e.type.trim() === "wasm");

        if (wasmEvents.length === 0) {
            console.error("No 'wasm' events found. Full result:", JSON.stringify(result, (key, value) =>
                typeof value === 'bigint' ? value.toString() : value, null, 2));
            throw new Error("No 'wasm' events found.");
        }

        // Extract the relevant attributes from the wasm events
        wasmEvents.forEach((event) => {
            const pairName = event.attributes.find(attr => attr.key === 'pair');
            const pairAddress = event.attributes.find(attr => attr.key === 'pair_contract_addr');

            if (pairName && pairAddress) {
                const pairInfo = {
                    pairName: pairName.value,
                    pairAddress: pairAddress.value,
                };
                console.info(`Pair initialized:\n${JSON.stringify(pairInfo, null, 4)}\n`);
                pairs.push(pairInfo);
            }
        });
    }

    return pairs;
}

async function instantiateDaoCoreWithModules(client, wallet, gasPriceS, daoCoreCodeId, cw4StakeCodeId, proposalSingleCodeId, cw20Contract) {
    console.info('Instantiating DAO Core with modules...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const instantiateFee = calculateFee(1_000_000, gasPrice);

    const daoCoreInstantiateMsg = {
        admin: wallet,
        name: "My DAO",
        description: "Description of My DAO",
        image_url: "https://example.com/image.png",
        automatically_add_cw20s: true,
        automatically_add_cw721s: true,
        voting_module_instantiate_info: {
            code_id: cw4StakeCodeId,
            msg: Buffer.from(JSON.stringify({
                cw20_contract: cw20Contract,  // Replace with actual CW20 token contract address
                tokens_per_power: "1000000",  // Adjust as per requirement
                min_bond: "1000000",  // Adjust as per requirement
                stake_config: [],  // Adjust as per requirement
                admin: wallet  // Admin is the wallet
            })).toString('base64'),
            admin: { address: wallet },  // Set admin to the wallet address
            funds: [],
            label: "CW4 Stake Voting Module"
        },
        proposal_modules_instantiate_info: [
            {
                code_id: proposalSingleCodeId,
                msg: Buffer.from(JSON.stringify({
                    threshold: {
                        threshold_quorum: {
                            quorum: "0.1",  // 10% quorum
                            threshold: "0.5"  // 50% threshold
                        }
                    },
                    max_voting_period: { time: 604800 },  // 7 days in seconds
                    min_voting_period: { time: 86400 },  // 1 day in seconds
                    only_members_execute: false,
                    allow_revoting: true,
                    pre_propose_info: { anyone_may_propose: {} },  // Adjust as per requirements
                    close_proposal_on_execution_failure: true,
                    veto: null
                })).toString('base64'),
                admin: { address: wallet },  // Set admin to the wallet address
                funds: [],
                label: "Proposal Single Module"
            }
        ],
        initial_items: [],
        dao_uri: "https://mydao.org"  // Optional DAO URI
    };

    // Instantiate DAO Core with the voting and proposal modules
    const { contractAddress: daoCoreAddress } = await client.instantiate(
        wallet,
        daoCoreCodeId,
        daoCoreInstantiateMsg,
        "DAO Core with Modules",
        instantiateFee,
        {
            memo: "Instantiation of DAO Core with voting and proposal modules",
            admin: wallet,
        }
    );

    console.info(`DAO Core instantiated at ${daoCoreAddress} with voting and proposal modules\n`);
    return daoCoreAddress;
}

async function instantiateGaugeAdapters(client, wallet, gasPriceS, codeId, config) {
    console.info('Instantiating gauge adapters...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const instantiateFee = calculateFee(1_000_000, gasPrice);

    var adapters = [];

    for (var i = 0; i < config.length; i++) {
        const {contractAddress} = await client.instantiate(
            wallet,
            codeId,
            config[i].instantiate,
            config[i].label,
            instantiateFee,
            {
                memo: "Instantiation " + config[i].label,
                admin: wallet,
            },
        );
        console.info(config[i].label + ` contract instantiated at ${contractAddress}\n`);
        const adapter = {
            "label": config[i].label,
            "address": contractAddress
        };
        adapters.push(adapter);
    };

    return adapters;
}

async function createGauges(client, wallet, gasPriceS, messages, gaugeOrchestratorAddress) {
    console.info('Executing CreateGauge message...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const executeFee = calculateFee(1_000_000, gasPrice);

    var gauges = [];

    for (var i = 0; i < messages.length; i++) {
        const result = await client.execute(
            wallet,
            gaugeOrchestratorAddress,
            messages[i],
            executeFee
        );
        const wasmEvent = result.logs[0].events.find((e) => e.type === "wasm").attributes;
        const gaugeAddress = wasmEvent.find(function (element) {
            return element.key === '_contract_address'
        });
        const gaugeInfo = {
            gaugeLabel: messages[i].create_gauge.title,
            gaugeAddress: gaugeAddress.value,
        };
        console.info(`Gauge initialized:\n${JSON.stringify(gaugeInfo, null, 4)}\n`);
        gauges.push(gaugeInfo);
    };

    return gauges;
}

async function main() {
    const mnemonic = getMnemonic();

    const palomaConfig = JSON.parse(fs.readFileSync(palomaConfigPath, 'utf8'));
    console.info(`Using paloma config:\n${JSON.stringify(palomaConfig, null, 4)}\n`);

    const {client, address} = await connect(mnemonic, palomaConfig);

    // Store palomadex-stake, pair and pair-stable required for factory's instantiation
    const tokenCodeId = 6; // await storeContract(client, address, palomaConfig.gasPrice, "token", tokenWasmPath);
    const pairCodeId = 7; // await storeContract(client, address, palomaConfig.gasPrice, "pair", pairWasmPath);
    const pairStableCodeId = 8; // await storeContract(client, address, palomaConfig.gasPrice, "pair-stable", pairStableWasmPath);
    const stakeCodeId = 9; // await storeContract(client, address, palomaConfig.gasPrice, "stake", stakeWasmPath);
    const factoryCodeId = 5; // await storeContract(client, address, palomaConfig.gasPrice, "factory", factoryWasmPath);
    const multiHopCodeId = 10; // await storeContract(client, address, palomaConfig.gasPrice, "multi-hop", multiHopWasmPath);
    const gaugeOrchestratorCodeId = 11; // await storeContract(client, address, palomaConfig.gasPrice, "gauge-orchestrator", gaugeOrchestratorWasmPath);
    const gaugeAdapterCodeId = 12; // await storeContract(client, address, palomaConfig.gasPrice, "gauge-adapter", gaugeAdapterWasmPath);

    console.info("token_code_id: " + tokenCodeId);
    console.info("pair_code_id: " + pairCodeId);
    console.info("pair_stable_code_id: " + pairStableCodeId);
    console.info("staking_code_id: " + stakeCodeId);

    await stdio.ask('\nUpdate configs/factory_config.json using proper codeIDs from above and press ENTER to continue', function () {});
    console.info('');

    // CW20 token instantiation message with a high initial balance for the wallet
    const cw20InstantiateMsg = {
        name: "MyToken",
        symbol: "MTK",
        decimals: 6,
        initial_balances: [{
            address: address,  // The wallet address receiving the initial balance
            amount: "1000000000"  // Set a high initial balance for the wallet (1,000,000 MTK)
        }],
        mint: {
            minter: wallet,
            cap: null  // No cap on minting
        },
        marketing: null  // Optional marketing information
    };

    // Instantiate CW20 Token Contract
    const cw20TokenAddress = await instantiateContract(client, wallet, palomaConfig.gasPrice, {
        label: "MyToken Contract",
        instantiate: cw20InstantiateMsg
    }, tokenCodeId);

    console.info(`CW20 token contract instantiated at ${cw20TokenAddress}`);

    // factory
    const factoryConfig = JSON.parse(fs.readFileSync(factoryConfigPath, 'utf8'));
    const factoryAddress = await instantiateContract(client, address, palomaConfig.gasPrice, factoryConfig, factoryCodeId);

    await stdio.ask("Update configs/multi_hop_config.json and configs/gauges_config.json using factory's address from above and press ENTER to continue", function () {});
    console.info('');

    // multi hop
    const multiHopConfig = JSON.parse(fs.readFileSync(multiHopConfigPath, 'utf8'));
    const multiHopAddress = await instantiateContract(client, address, palomaConfig.gasPrice, multiHopConfig, multiHopCodeId);

    // create pairs
    const pairs = await createPairsAndDistributionFlows(client, address, palomaConfig.gasPrice, factoryConfig, factoryAddress);

    // INSTANTIATE THE DAO - DAO-CORE, CW-PROPOSAL-SINGLE AND WYND-STAKE
    const daoCoreCodeId = await storeContract(client, wallet, palomaConfig.gasPrice, "dao-core", daoCoreWasmPath);
    const proposalSingleCodeId = await storeContract(client, wallet, palomaConfig.gasPrice, "proposal-single", proposalSingleWasmPath);
    const cw4StakeCodeId = await storeContract(client, wallet, palomaConfig.gasPrice, "cw4-stake", cw4StakeWasmPath);

    // Instantiate DAO Core and its modules
    const daoCoreAddress = await instantiateDaoCoreWithModules(client, wallet, palomaConfig.gasPrice, daoCoreCodeId, cw4StakeCodeId, proposalSingleCodeId, cw20Contract);

    console.info(`DAO Core and its modules have been successfully instantiated. DAO Core Address: ${daoCoreAddress}`);
    // gauges
    // const gaugesConfig = JSON.parse(fs.readFileSync(gaugesConfigPath, 'utf8'));
    // const gaugeOrchestratorAddress = await instantiateContract(client, address, palomaConfig.gasPrice, gaugesConfig.orchestrator, gaugeOrchestratorCodeId);
    // const gaugeAdapters = await instantiateGaugeAdapters(client, address, palomaConfig.gasPrice, gaugeAdapterCodeId, gaugesConfig.adapters);

    // await stdio.ask("Update configs/gauges_config.json and paste proper gaugeAdapter addresses into proper create_gauge messages; press ENTER when ready to continue", function () {});
    // console.info('');

    // const gauges = await createGauges(client, address, palomaConfig.gasPrice, gaugesConfig.gauges, gaugeOrchestratorAddress);

    // save output to logfile
    const raport = {
        tokenCodeId: tokenCodeId,
        pairCodeId: pairCodeId,
        pairStableCodeId: pairStableCodeId,
        stakeCodeId: stakeCodeId,
        multiHopCodeId: multiHopCodeId,
        factoryCodeId: factoryCodeId,
        gaugeOrchestratorCodeId: gaugeOrchestratorCodeId,
        gaugeAdapterCodeId: gaugeAdapterCodeId,
        factoryAddress: factoryAddress,
        multiHopAddress: multiHopAddress,
        pairs: pairs,
        // gaugeOrchestratorAddress: gaugeOrchestratorAddress,
        // gaugeAdapters: gaugeAdapters,
        // gauges: gauges
    };
    fs.writeFileSync("result.json", JSON.stringify(raport, null, 4), "utf8");
    console.info("Result was saved to result.json file!");
}

main().then(
    () => {
        console.info("All done, let the coins flow.");
        process.exit(0);
    },
    (error) => {
        console.error(error);
        process.exit(1);
    },
)

