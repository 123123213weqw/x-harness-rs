"""Frozen external limits, shared by both native harnesses."""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Protocol:
    model: str = 'deepseek-flash'
    seconds: int = 600
    context_window: int = 65536
    max_output_tokens: int = 16384
    max_calls: int = 40
    dollars: float = 0.50
    input_rate: float = 0.30 / 1_000_000
    output_rate: float = 1.20 / 1_000_000

    def __post_init__(self):
        if not (1 <= self.seconds <= 600 and 1 <= self.max_calls <= 40
                and 0 < self.dollars <= .50 and 1 <= self.max_output_tokens <= 16384
                and self.context_window == 65536 and self.model == 'deepseek-flash'
                and self.input_rate >= .30 / 1_000_000
                and self.output_rate >= 1.20 / 1_000_000):
            raise ValueError('protocol exceeds approved limits or under-reserves cost')

    def wire(self):
        return asdict(self)


OFFICIAL = Protocol()
