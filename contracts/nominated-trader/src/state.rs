use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Decimal};
use cw_storage_plus::{Item, Map};
use palomadex::asset::{AssetInfo, AssetInfoValidated};

#[cw_serde]
pub struct Config {
    /// Address that's allowed to change contract parameters
    pub owner: Addr,
    /// Address that's allowed to perform swaps and convert fee tokens to Paloma as needed
    pub nominated_trader: Addr,
    /// Address specified to receive any payouts usually distinct from the nominated_trader address
    pub beneficiary: Addr,
    /// The Grain token contract address
    pub token_contract: AssetInfoValidated,
    /// The Palomadex factory contract address
    pub dex_factory_contract: Addr,
    /// The maximum spread used when swapping fee tokens to PALOMA
    pub max_spread: Decimal,
}

/// Stores the contract configuration at the given key
pub const CONFIG: Item<Config> = Item::new("config");

/// Stores bridge tokens used to swap fee tokens to PALOMA
pub const ROUTES: Map<String, AssetInfo> = Map::new("routes");
