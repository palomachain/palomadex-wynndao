use cosmwasm_std::testing::{MockApi, MockQuerier, MockStorage, MOCK_CONTRACT_ADDR};
use cosmwasm_std::{
    from_binary, from_slice, to_binary, Coin, Empty, OwnedDeps, Querier, QuerierResult,
    QueryRequest, SystemError, SystemResult, WasmQuery,
};
use palomadex::pair::PairInfo;
use palomadex::pair::QueryMsg;
use std::collections::HashMap;

/// mock_dependencies is a drop-in replacement for cosmwasm_std::testing::mock_dependencies.
/// This uses the Palomadex CustomQuerier.
pub fn mock_dependencies(
    contract_balance: &[Coin],
) -> OwnedDeps<MockStorage, MockApi, WasmMockQuerier> {
    let custom_querier: WasmMockQuerier =
        WasmMockQuerier::new(MockQuerier::new(&[(MOCK_CONTRACT_ADDR, contract_balance)]));

    OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier: custom_querier,
        custom_query_type: Default::default(),
    }
}

pub struct WasmMockQuerier {
    base: MockQuerier<Empty>,
    palomadex_pair_querier: PalomadexPairQuerier,
}

#[derive(Clone, Default)]
pub struct PalomadexPairQuerier {
    pairs: HashMap<String, PairInfo>,
}

impl PalomadexPairQuerier {
    pub fn new(pairs: &[(&String, &PairInfo)]) -> Self {
        PalomadexPairQuerier {
            pairs: pairs_to_map(pairs),
        }
    }
}

pub(crate) fn pairs_to_map(pairs: &[(&String, &PairInfo)]) -> HashMap<String, PairInfo> {
    let mut pairs_map: HashMap<String, PairInfo> = HashMap::new();
    for (key, pair) in pairs.iter() {
        pairs_map.insert(key.to_string(), (*pair).clone());
    }
    pairs_map
}

impl Querier for WasmMockQuerier {
    fn raw_query(&self, bin_request: &[u8]) -> QuerierResult {
        // MockQuerier doesn't support Custom, so we ignore it completely
        let request: QueryRequest<Empty> = match from_slice(bin_request) {
            Ok(v) => v,
            Err(e) => {
                return SystemResult::Err(SystemError::InvalidRequest {
                    error: format!("Parsing query request: {}", e),
                    request: bin_request.into(),
                })
            }
        };
        self.handle_query(&request)
    }
}

impl WasmMockQuerier {
    pub fn handle_query(&self, request: &QueryRequest<Empty>) -> QuerierResult {
        match &request {
            QueryRequest::Wasm(WasmQuery::Smart {contract_addr, msg})// => {
                => match from_binary(msg).unwrap() {
                    QueryMsg::Pair {} => {
                       let pair_info: PairInfo =
                        match self.palomadex_pair_querier.pairs.get(contract_addr) {
                            Some(v) => v.clone(),
                            None => {
                                return SystemResult::Err(SystemError::NoSuchContract {
                                    addr: contract_addr.clone(),
                                })
                            }
                        };

                    SystemResult::Ok(to_binary(&pair_info).into())
                    }
                    _ => panic!("DO NOT ENTER HERE")
            }
            _ => self.base.handle_query(request),
        }
    }
}

impl WasmMockQuerier {
    pub fn new(base: MockQuerier<Empty>) -> Self {
        WasmMockQuerier {
            base,
            palomadex_pair_querier: PalomadexPairQuerier::default(),
        }
    }

    // Configure the Palomadex pair
    pub fn with_palomadex_pairs(&mut self, pairs: &[(&String, &PairInfo)]) {
        self.palomadex_pair_querier = PalomadexPairQuerier::new(pairs);
    }
}
