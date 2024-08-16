#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    coin, ensure_eq, to_binary, Addr, Binary, Coin, Deps, DepsMut, Empty, Env, MessageInfo, Order,
    Reply, Response, StdResult, SubMsg, Uint128, WasmMsg,
};

use cw20::Cw20ExecuteMsg;
use palomadex::asset::{Asset, AssetInfo};
use wasmswap::msg::InfoResponse;

use crate::error::ContractError;
use crate::msg::{ExecuteMsg, QueryMsg};
use crate::state::{MigrateStakersConfig, DESTINATION, EXCHANGE_CONFIG, MIGRATION};

// this is the contract we are migrating from
pub const STAKE_CW20_NAME: &str = "crates.io:stake_cw20";

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    _deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    _msg: Empty,
) -> Result<Response, ContractError> {
    Err(ContractError::NotImplemented)
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(_deps: Deps, _env: Env, msg: QueryMsg) -> Result<Binary, ContractError> {
    match msg {
        QueryMsg::MigrationFinished {} => {
            let no_stakers = stake_cw20::state::STAKED_BALANCES
                .keys(_deps.storage, None, None, Order::Ascending)
                .next()
                .is_none();
            Ok(to_binary(&no_stakers)?)
        }
    }
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::MigrateTokens { palomadex_pool } => migrate_tokens(deps, env, info, palomadex_pool),
        ExecuteMsg::MigrateStakers { limit } => migrate_stakers(deps, env, info, limit),
    }
}

/// Allow `migrator` to pull out LP positions and send them to paloma dex pool
/// First step figures out how many LPs we have and withdraws them.
/// Follow up via reply.
pub fn migrate_tokens(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    palomadex_pool: String,
) -> Result<Response, ContractError> {
    // make sure called by proper account
    let mut migration = MIGRATION.load(deps.storage)?;
    if info.sender != migration.migrator {
        return Err(ContractError::Unauthorized);
    }

    // ensure the requested target pool is valid
    let w_pool = deps.api.addr_validate(&palomadex_pool)?;
    if let Some(ref target) = migration.palomadex_pool {
        if target != w_pool {
            return Err(ContractError::InvalidDestination(palomadex_pool));
        }
    }
    let ci = deps.querier.query_wasm_contract_info(&w_pool)?;
    if ci.creator != migration.factory {
        return Err(ContractError::InvalidDestination(palomadex_pool));
    }

    // save target pool for later reply block
    DESTINATION.save(deps.storage, &w_pool)?;

    // calculate LP tokens owner by staking contract,
    // for withdrawal and for future distribution
    let stake_cfg = stake_cw20::state::CONFIG.load(deps.storage)?;
    let token = cw20::Cw20Contract(stake_cfg.token_address);
    let balance = token.balance(&deps.querier, env.contract.address)?;

    // fill in most of the migration data now (minus paloma dex LP)
    let palomadex::pair::PairInfo {
        liquidity_token,
        staking_addr,
        ..
    } = deps
        .querier
        .query_wasm_smart(&w_pool, &palomadex::pair::QueryMsg::Pair {})?;

    // total_staked is same a balance of junoswap lp token held by this contract
    migration.migrate_stakers_config = Some(MigrateStakersConfig {
        lp_token: liquidity_token,
        staking_addr,
        total_lp_tokens: Uint128::zero(),
        total_staked: balance,
    });
    MIGRATION.save(deps.storage, &migration)?;

    // trigger withdrawal of LP tokens
    // we need to assign a cw20 allowance to let the pool burn LP
    let allowance = WasmMsg::Execute {
        contract_addr: token.0.to_string(),
        funds: vec![],
        msg: to_binary(&cw20::Cw20ExecuteMsg::IncreaseAllowance {
            spender: migration.junoswap_pool.to_string(),
            amount: balance,
            expires: None,
        })?,
    };

    // then craft the LP withdrawal message
    let withdraw = WasmMsg::Execute {
        contract_addr: migration.junoswap_pool.into_string(),
        funds: vec![],
        msg: to_binary(&wasmswap::msg::ExecuteMsg::RemoveLiquidity {
            amount: balance,
            min_token1: Uint128::zero(),
            min_token2: Uint128::zero(),
            expiration: None,
        })?,
    };

    // execute these and handle the next step in reply
    let res = Response::new()
        .add_message(allowance)
        .add_submessage(SubMsg::reply_on_success(withdraw, REPLY_ONE));
    Ok(res)
}

pub fn migrate_stakers(
    mut deps: DepsMut,
    env: Env,
    info: MessageInfo,
    limit: u32,
) -> Result<Response, ContractError> {
    // make sure called by proper account
    let migration = MIGRATION.load(deps.storage)?;
    ensure_eq!(info.sender, migration.migrator, ContractError::Unauthorized);

    let config = migration
        .migrate_stakers_config
        .ok_or(ContractError::TokensNotMigrated)?;

    // calculate next `limit` stakers and their shares
    let stakers = find_stakers(deps.as_ref(), limit)?;

    // remove the processed stakers from the state
    remove_stakers(deps.branch(), &env, stakers.iter().map(|(addr, _)| addr))?;

    let staker_lps: Vec<_> = stakers
        .into_iter()
        .map(|(addr, stake)| {
            (
                addr.to_string(),
                stake * config.total_lp_tokens / config.total_staked,
            )
        })
        .filter(|(_, x)| !x.is_zero())
        .collect();

    // the amount of LP tokens we are migrating in this message
    let batch_lp: Uint128 = staker_lps.iter().map(|(_, x)| x).sum();

    // bonding has full info on who receives the delegation
    let bond_msg = palomadex::stake::ReceiveMsg::MassDelegate {
        unbonding_period: migration.unbonding_period,
        delegate_to: staker_lps,
    };

    // stake it all
    let stake_msg = WasmMsg::Execute {
        contract_addr: config.lp_token.to_string(),
        funds: vec![],
        msg: to_binary(&cw20::Cw20ExecuteMsg::Send {
            contract: config.staking_addr.into_string(),
            amount: batch_lp,
            msg: to_binary(&bond_msg)?,
        })?,
    };

    Ok(Response::new().add_message(stake_msg))
}

const REPLY_ONE: u64 = 111;
const REPLY_TWO: u64 = 222;

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn reply(deps: DepsMut, env: Env, msg: Reply) -> Result<Response, ContractError> {
    if msg.result.is_err() {
        return Err(ContractError::ErrorReply);
    }
    match msg.id {
        REPLY_ONE => reply_one(deps, env),
        REPLY_TWO => reply_two(deps, env),
        x => Err(ContractError::UnknownReply(x)),
    }
}

/// In this step, we deposit the new raw tokens (eg. JUNO-ATOM) into PALOMA DEX
/// And get some liquid PALOMA DEX LP tokens
pub fn reply_one(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    let migration = MIGRATION.load(deps.storage)?;
    let destination = DESTINATION.load(deps.storage)?;

    // get the JS asset types and convert to PALOMA DEX types
    let info: InfoResponse = deps
        .querier
        .query_wasm_smart(migration.junoswap_pool, &wasmswap::msg::QueryMsg::Info {})?;
    let assets = to_palomadex_assets(deps.as_ref(), env.contract.address, info)?;

    // figure out how to transfer these... previous cw20 allowances or
    // sending native funds inline with providing liquidity
    let DenomDeposits {
        allowances,
        funds,
        new_assets,
    } = prepare_denom_deposits(deps.as_ref(), &destination, &assets)?;
    let deposit = WasmMsg::Execute {
        contract_addr: destination.into_string(),
        funds,
        msg: to_binary(&palomadex::pair::ExecuteMsg::ProvideLiquidity {
            assets: new_assets,
            // TODO: set some value here?
            slippage_tolerance: None,
            receiver: None,
        })?,
    };

    // add any cw20 allowances, then call to deposit the tokens and get LP
    let res = Response::new()
        .add_messages(allowances)
        .add_submessage(SubMsg::reply_on_success(deposit, REPLY_TWO));
    Ok(res)
}

struct DenomDeposits {
    allowances: Vec<WasmMsg>,
    funds: Vec<Coin>,
    new_assets: Vec<Asset>,
}

/// Checks if one of the denoms matches RAW address, then prepares extra BurnMsg
/// and provides PALOMA equivalent given by specified exchange rate
fn prepare_denom_deposits(
    deps: Deps,
    destination: &Addr,
    assets: &[Asset],
) -> Result<DenomDeposits, ContractError> {
    let mut allowances = vec![];
    let mut funds = vec![];

    let exchange_config = EXCHANGE_CONFIG.load(deps.storage)?;

    let raw_asset = AssetInfo::Token(exchange_config.raw_token.to_string());
    let new_assets = assets
        .iter()
        .map(|asset| {
            if asset.info == raw_asset {
                // first burn raw tokens
                let burn_msg = WasmMsg::Execute {
                    contract_addr: exchange_config.raw_token.to_string(),
                    msg: to_binary(&Cw20ExecuteMsg::Burn {
                        amount: asset.amount,
                    })?,
                    funds: vec![],
                };
                // add BurnMsg to messages
                allowances.push(burn_msg);
                // now return grain tokens instead
                Ok(Asset {
                    info: AssetInfo::Token(exchange_config.grain_token.to_string()),
                    amount: asset.amount * exchange_config.raw_to_grain_exchange_rate,
                })
            } else {
                Ok(asset.clone())
            }
        })
        .collect::<StdResult<Vec<Asset>>>()?;

    // sanity check
    debug_assert_eq!(new_assets.len(), 2);

    prepare_denom_deposit(destination, &new_assets[0], &mut allowances, &mut funds)?;
    prepare_denom_deposit(destination, &new_assets[1], &mut allowances, &mut funds)?;

    Ok(DenomDeposits {
        allowances,
        funds,
        new_assets,
    })
}

fn prepare_denom_deposit(
    destination: &Addr,
    asset: &Asset,
    msgs: &mut Vec<WasmMsg>,
    funds: &mut Vec<Coin>,
) -> Result<(), ContractError> {
    // build allowance msg or funds to transfer for this asset
    match &asset.info {
        AssetInfo::Token(token) => {
            let embed = cw20::Cw20ExecuteMsg::IncreaseAllowance {
                spender: destination.to_string(),
                amount: asset.amount,
                expires: None,
            };
            let msg = WasmMsg::Execute {
                contract_addr: token.to_string(),
                msg: to_binary(&embed)?,
                funds: vec![],
            };
            msgs.push(msg);
        }
        AssetInfo::Native(denom) => {
            let coin = coin(asset.amount.u128(), denom);
            funds.push(coin);
        }
    }
    Ok(())
}

fn to_palomadex_assets(
    deps: Deps,
    me: Addr,
    info: InfoResponse,
) -> Result<Vec<Asset>, ContractError> {
    let asset1 = to_palomadex_asset(deps, &me, info.token1_denom)?;
    let asset2 = to_palomadex_asset(deps, &me, info.token2_denom)?;
    Ok(vec![asset1, asset2])
}

fn to_palomadex_asset(
    deps: Deps,
    me: &Addr,
    token: wasmswap_cw20::Denom,
) -> Result<Asset, ContractError> {
    let asset = match token {
        wasmswap_cw20::Denom::Native(denom) => {
            let balance = deps.querier.query_balance(me, denom)?;
            Asset {
                info: AssetInfo::Native(balance.denom),
                amount: balance.amount,
            }
        }
        wasmswap_cw20::Denom::Cw20(addr) => {
            let token = cw20::Cw20Contract(addr);
            let amount = token.balance(&deps.querier, me)?;
            Asset {
                info: AssetInfo::Token(token.0.into_string()),
                amount,
            }
        }
    };
    Ok(asset)
}

/// Finally, with those PALOMA DEX LP tokens, we will take them all on behalf
/// of the original JunoSwap LP stakers.
pub fn reply_two(deps: DepsMut, env: Env) -> Result<Response, ContractError> {
    // load config for LP token and staking contract
    let mut migration = MIGRATION.load(deps.storage)?;
    let config = migration.migrate_stakers_config.as_mut().unwrap();

    // how many LP do we have total
    let lp_token = cw20::Cw20Contract(config.lp_token.clone());
    let total_lp_tokens = lp_token.balance(&deps.querier, env.contract.address)?;

    // store this for `migrate_stakers` to use
    config.total_lp_tokens = total_lp_tokens;
    MIGRATION.save(deps.storage, &migration)?;

    Ok(Response::new())
}

// query logic taken from https://github.com/cosmorama/wyndex-priv/pull/109
fn find_stakers(deps: Deps, limit: impl Into<Option<u32>>) -> StdResult<Vec<(Addr, Uint128)>> {
    let balances = stake_cw20::state::STAKED_BALANCES
        .range(deps.storage, None, None, Order::Ascending)
        .map(|stake| {
            let (addr, amount) = stake?;

            // query all pending claims and bond them as well
            let claims = stake_cw20::state::CLAIMS.query_claims(deps, &addr)?;
            let claims_sum = claims.claims.iter().map(|c| c.amount).sum::<Uint128>();

            Ok((addr, amount + claims_sum))
        });
    match limit.into() {
        Some(limit) => balances.take(limit as usize).collect(),
        None => balances.collect(),
    }
}

fn remove_stakers<'a>(
    deps: DepsMut,
    env: &Env,
    stakers: impl Iterator<Item = &'a Addr>,
) -> Result<(), ContractError> {
    for staker in stakers {
        stake_cw20::state::STAKED_BALANCES.remove(deps.storage, staker, env.block.height)?;
    }
    Ok(())
}
