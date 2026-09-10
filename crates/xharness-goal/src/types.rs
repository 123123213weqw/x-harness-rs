pub use xharness_session::goal::*;

pub(crate) fn require(ok: bool, field: &'static str) -> Result<(), GoalContractError> {
    if ok {
        Ok(())
    } else {
        Err(GoalContractError { field })
    }
}
