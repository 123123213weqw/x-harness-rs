use serde::{Deserialize, Serialize};

/// Public lifecycle state of a long-lived agent activation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    #[default]
    Idle,
    Running,
}

/// Internal activity reservation. Maintenance stays publicly idle, matching
/// the upstream driver while still excluding turn execution.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentPhase {
    #[default]
    Idle,
    Maintenance,
    Running {
        turn: u32,
        step: u32,
    },
}

impl AgentPhase {
    pub const fn status(self) -> AgentStatus {
        match self {
            Self::Idle | Self::Maintenance => AgentStatus::Idle,
            Self::Running { .. } => AgentStatus::Running,
        }
    }
}

/// Pure transition guard used by the asynchronous supervisor.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentLifecycle {
    phase: AgentPhase,
    last_turn: u32,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum LifecycleError {
    #[error("agent already has active work")]
    AlreadyActive,
    #[error("agent is not running")]
    NotRunning,
    #[error("turn or step counter overflow")]
    CounterOverflow,
}

impl AgentLifecycle {
    pub const fn new(last_turn: u32) -> Self {
        Self {
            phase: AgentPhase::Idle,
            last_turn,
        }
    }

    pub const fn phase(&self) -> AgentPhase {
        self.phase
    }

    pub const fn status(&self) -> AgentStatus {
        self.phase.status()
    }

    pub fn reserve_driver(&mut self) -> Result<(), LifecycleError> {
        if self.phase != AgentPhase::Idle {
            return Err(LifecycleError::AlreadyActive);
        }
        self.phase = AgentPhase::Running {
            turn: self.last_turn,
            step: 0,
        };
        Ok(())
    }

    pub fn open_turn(&mut self) -> Result<u32, LifecycleError> {
        let AgentPhase::Running { turn, .. } = self.phase else {
            return Err(LifecycleError::NotRunning);
        };
        let next = turn.checked_add(1).ok_or(LifecycleError::CounterOverflow)?;
        self.phase = AgentPhase::Running {
            turn: next,
            step: 0,
        };
        self.last_turn = next;
        Ok(next)
    }

    pub fn open_step(&mut self) -> Result<(u32, u32), LifecycleError> {
        let AgentPhase::Running { turn, step } = self.phase else {
            return Err(LifecycleError::NotRunning);
        };
        let next = step.checked_add(1).ok_or(LifecycleError::CounterOverflow)?;
        self.phase = AgentPhase::Running { turn, step: next };
        Ok((turn, next))
    }

    pub fn finish_driver(&mut self) -> Result<(), LifecycleError> {
        if !matches!(self.phase, AgentPhase::Running { .. }) {
            return Err(LifecycleError::NotRunning);
        }
        self.phase = AgentPhase::Idle;
        Ok(())
    }

    pub fn reserve_maintenance(&mut self) -> Result<(), LifecycleError> {
        if self.phase != AgentPhase::Idle {
            return Err(LifecycleError::AlreadyActive);
        }
        self.phase = AgentPhase::Maintenance;
        Ok(())
    }

    pub fn finish_maintenance(&mut self) -> Result<(), LifecycleError> {
        if self.phase != AgentPhase::Maintenance {
            return Err(LifecycleError::AlreadyActive);
        }
        self.phase = AgentPhase::Idle;
        Ok(())
    }
}
