use cosmwasm_schema::write_api;
use palomadex::stake::InstantiateMsg;
use palomadex_stake::msg::{ExecuteMsg, QueryMsg};

fn main() {
    write_api! {
        instantiate: InstantiateMsg,
        query: QueryMsg,
        execute: ExecuteMsg,
    }
}
