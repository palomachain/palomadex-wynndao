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

const factoryWasmPath = "/contracts/palomadex_factory.wasm";
const gaugeAdapterWasmPath = "/contracts/gauge_adapter.wasm";
const gaugeOrchestratorWasmPath = "/contracts/gauge_orchestrator.wasm";
const multiHopWasmPath = "/contracts/palomadex_multi_hop.wasm";
const pairWasmPath = "/contracts/palomadex_pair.wasm";
const pairStableWasmPath = "/contracts/palomadex_pair_lsd.wasm";
const stakeWasmPath = "/contracts/palomadex_stake.wasm";
const tokenWasmPath = "/contracts/cw20_base.wasm";
const daoCoreWasmPath = "/contracts/dao_dao_core.wasm";
const proposalSingleWasmPath = "/contracts/dao_proposal_single.wasm";

// Check "MNEMONIC" env variable and ensure it is set to a reasonable value
function getMnemonic() {
    const mnemonic = env["MNEMONIC"];
    if (!mnemonic || mnemonic.length < 48) {
        throw new Error("Must set MNEMONIC to a 12 word phrase");
    }
    return mnemonic;
}

// Function to read and parse JSON config file
function readJsonConfig(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Function to write JSON config file
function writeJsonConfig(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), "utf8");
    console.info(`Updated ${filePath}`);
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
    const uploadReceipt = await client.upload(
        wallet,
        wasmBinary,
        uploadFee,
        "Upload " + label + " contract",
    );
    console.info(label + " uploaded successfully. Receipt:\n" + JSON.stringify(uploadReceipt, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value // Convert BigInt to string
        ) + '\n');

    return uploadReceipt.codeId;
}

async function instantiateContract(client, wallet, gasPriceS, config, codeId) {
    console.info('Instantiating ' + config.label + '...');

    const gasPrice = GasPrice.fromString(gasPriceS);
    const instantiateFee = calculateFee(500_000, gasPrice);

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

    // Corrected Voting Module Instantiate Message
    const votingModuleInstantiateInfo = {
        code_id: cw4StakeCodeId,
        msg: Buffer.from(JSON.stringify({
            cw20_contract: cw20Contract,
            tokens_per_power: "1000000",
            min_bond: "1000000",
            stake_config: [
                {
                    unbonding_period: 86400,  // in seconds
                    voting_multiplier: "1.0",  // as a string
                    reward_multiplier: "1.0"  // as a string
                }
            ],
            admin: null  // No admin specified for the voting module
        })).toString('base64'),
        admin: { none: {} },  // Correct use of the "address" variant of Admin enum
        label: "CW4 Stake Voting Module"
    };

    // Corrected Proposal Module Instantiate Message
    const proposalModulesInstantiateInfo = [{
        code_id: proposalSingleCodeId,
        msg: Buffer.from(JSON.stringify({
            threshold: {
                threshold_quorum: {
                    quorum: { majority: {} },  // Correct use of the "majority" variant for quorum
                    threshold: { majority: {} }  // Correct use of the "majority" variant for threshold
                }
            },
            max_voting_period: { time: 604800 },  // 7 days in seconds
            min_voting_period: { time: 86400 },  // 1 day in seconds
            allow_revoting: true,
            deposit_info: {
                token: {
                    token: {
                        address: cw20Contract  // Correct token address for the deposit
                    }
                },
                deposit: "1000",  // Minimum deposit required as a string
                refund_failed_proposals: true
            },
            executor: { Only: wallet }  // Correct use of the "Only" variant with a specific address
        })).toString('base64'),
        admin: { none: {} },  // Correct use of the "address" variant of Admin enum
        label: "Proposal Single Module"
    }];

    // Prepare the DAO Core instantiation message
    const daoCoreInstantiateMsg = {
        admin: null,  // This should be null or a valid address
        name: "My DAO",
        description: "Description of My DAO",
        image_url: "https://example.com/image.png",
        automatically_add_cw20s: true,
        automatically_add_cw721s: true,
        voting_module_instantiate_info: votingModuleInstantiateInfo,
        proposal_modules_instantiate_info: proposalModulesInstantiateInfo,
        initial_items: [],  // Optional, adjust as needed
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
            admin: null,  // Set this to null if no admin is required after instantiation
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

    for (var i = 0; i < messages.length; i++) {
        const result = await client.execute(
            wallet,
            gaugeOrchestratorAddress,
            messages[i],
            executeFee
        );
        console.info(`Gauge initialized: ${messages[i].create_gauge.title}\n`);
    };
}

async function main() {
    const mnemonic = getMnemonic();

    const palomaConfig = JSON.parse(fs.readFileSync(palomaConfigPath, 'utf8'));
    console.info(`Using paloma config:\n${JSON.stringify(palomaConfig, null, 4)}\n`);

    const {client, address} = await connect(mnemonic, palomaConfig);

    const factoryConfig = readJsonConfig(factoryConfigPath);

    // Store palomadex-stake, pair and pair-stable required for factory's instantiation
    const tokenCodeId = await storeContract(client, address, palomaConfig.gasPrice, "token", tokenWasmPath);
    const pairCodeId = await storeContract(client, address, palomaConfig.gasPrice, "pair", pairWasmPath);
    const pairStableCodeId = await storeContract(client, address, palomaConfig.gasPrice, "pair-stable", pairStableWasmPath);
    const stakeCodeId = await storeContract(client, address, palomaConfig.gasPrice, "stake", stakeWasmPath);
    const factoryCodeId = await storeContract(client, address, palomaConfig.gasPrice, "factory", factoryWasmPath);
    const multiHopCodeId = await storeContract(client, address, palomaConfig.gasPrice, "multi-hop", multiHopWasmPath);
    const gaugeOrchestratorCodeId = await storeContract(client, address, palomaConfig.gasPrice, "gauge-orchestrator", gaugeOrchestratorWasmPath);
    const gaugeAdapterCodeId = await storeContract(client, address, palomaConfig.gasPrice, "gauge-adapter", gaugeAdapterWasmPath);

    console.info("token_code_id: " + tokenCodeId);
    console.info("pair_code_id: " + pairCodeId);
    console.info("pair_stable_code_id: " + pairStableCodeId);
    console.info("staking_code_id: " + stakeCodeId);

    // Update the config with new code IDs
    factoryConfig.instantiate.token_code_id = tokenCodeId;
    factoryConfig.instantiate.pair_configs[0].code_id = pairCodeId;
    factoryConfig.instantiate.pair_configs[1].code_id = pairStableCodeId;
    factoryConfig.instantiate.default_stake_config.staking_code_id = stakeCodeId;

    writeJsonConfig(factoryConfigPath, factoryConfig);


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
            minter: address,
            cap: null  // No cap on minting
        },
        marketing: null  // Optional marketing information
    };

    // Instantiate CW20 Token Contract
    const cw20TokenAddress = await instantiateContract(client, address, palomaConfig.gasPrice, {
        label: "MyToken Contract",
        instantiate: cw20InstantiateMsg
    }, tokenCodeId);

    console.info(`CW20 token contract instantiated at ${cw20TokenAddress}`);

    // factory
    const factoryAddress = await instantiateContract(client, address, palomaConfig.gasPrice, factoryConfig, factoryCodeId);

    // multi hop
    const multiHopConfig = readJsonConfig(multiHopConfigPath);
    multiHopConfig.instantiate.palomadex_factory = factoryAddress;
    writeJsonConfig(multiHopConfigPath, multiHopConfig);
    const multiHopAddress = await instantiateContract(client, address, palomaConfig.gasPrice, multiHopConfig, multiHopCodeId);

    // create pairs
    const pairs = await createPairsAndDistributionFlows(client, address, palomaConfig.gasPrice, factoryConfig, factoryAddress);

    // INSTANTIATE THE DAO - DAO-CORE, CW-PROPOSAL-SINGLE AND PALOMADEX-STAKE
    const daoCoreCodeId = await storeContract(client, address, palomaConfig.gasPrice, "dao-core", daoCoreWasmPath);
    const proposalSingleCodeId = await storeContract(client, address, palomaConfig.gasPrice, "proposal-single", proposalSingleWasmPath);
    const cw4StakeCodeId = await storeContract(client, address, palomaConfig.gasPrice, "cw4-stake", stakeWasmPath);

    // Instantiate DAO Core and its modules
    const daoCoreAddress = await instantiateDaoCoreWithModules(client, address, palomaConfig.gasPrice, daoCoreCodeId, cw4StakeCodeId, proposalSingleCodeId, cw20TokenAddress);

    console.info(`DAO Core and its modules have been successfully instantiated. DAO Core Address: ${daoCoreAddress}`);

    // gauges
    // Update the gauges config
    const gaugesConfig = readJsonConfig(gaugesConfigPath);
    gaugesConfig.orchestrator.instantiate.owner = address;
    gaugesConfig.adapters.forEach(adapter => {
        adapter.instantiate.factory = factoryAddress;
    });

    // Instantiate gauge orchestrator
    const gaugeOrchestratorAddress = await instantiateContract(client, address, palomaConfig.gasPrice, gaugesConfig.orchestrator, gaugeOrchestratorCodeId);

    const gaugeAdapters = await instantiateGaugeAdapters(client, address, palomaConfig.gasPrice, gaugeAdapterCodeId, gaugesConfig.adapters);

    gaugesConfig.gauges.forEach(gauge => {
        gauge.create_gauge.adapter = gaugeAdapters[0].address;
    });

    // Save the updated gauges config with gauge orchestrator and adapters addresses
    writeJsonConfig(gaugesConfigPath, gaugesConfig);

    const gauges = await createGauges(client, address, palomaConfig.gasPrice, gaugesConfig.gauges, gaugeOrchestratorAddress);

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
        daoCore: daoCoreAddress,
        gaugeOrchestratorAddress: gaugeOrchestratorAddress,
        gaugeAdapters: gaugeAdapters,
        gauges: gauges
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

