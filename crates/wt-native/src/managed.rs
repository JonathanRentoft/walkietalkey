//! TODO
#[derive(Debug, Clone, PartialEq)]
pub enum ManagedValue { Text(String), Bool(bool), Int(i64) }
pub fn read_managed() -> std::collections::BTreeMap<String, ManagedValue> { Default::default() }
