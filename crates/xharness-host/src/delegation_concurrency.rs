//! Startup-only child-turn capacity; independent of admission and tool limits.
use std::str::FromStr;

/// Validated capacity shared by all delegated conversations in one Host.
/// Primary turns do not consume these permits. A permit covers the entire
/// child turn, including tool execution; this is not a provider request limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DelegationConcurrency {
    Two,
    #[default]
    Four,
    Eight,
}

impl DelegationConcurrency {
    pub const fn limit(self) -> usize {
        match self {
            Self::Two => 2,
            Self::Four => 4,
            Self::Eight => 8,
        }
    }
}

impl FromStr for DelegationConcurrency {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "2" => Ok(Self::Two),
            "4" => Ok(Self::Four),
            "8" => Ok(Self::Eight),
            _ => Err("invalid delegation concurrency: expected 2, 4 or 8".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_four_and_only_bounded_choices_are_accepted() {
        assert_eq!(DelegationConcurrency::default().limit(), 4);
        for n in [2, 4, 8] {
            assert_eq!(
                n.to_string()
                    .parse::<DelegationConcurrency>()
                    .unwrap()
                    .limit(),
                n
            );
        }
        for invalid in [
            "",
            "0",
            "1",
            "3",
            "9",
            "16",
            "-1",
            "4.0",
            " 4 ",
            "18446744073709551616",
        ] {
            assert!(
                invalid.parse::<DelegationConcurrency>().is_err(),
                "{invalid}"
            );
        }
    }
}
