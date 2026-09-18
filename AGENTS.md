# Working on 3JSN

- Read README.md and relevant architecture/compatibility decisions before changing boundaries.
- Preserve the product goal: unchanged Three.js game source, including required HTML/CSS and browser APIs.
- Favor small, explicit modules and maintained dependencies; avoid speculative abstraction and broad forks.
- Document public behavior, ownership, errors and non-obvious decisions. Every comment must have a purpose; do not narrate the code.
- Distinguish proposed features, executable probes and verified support. Never claim a platform or speedup from compilation alone.
- Run checks relevant to the change. GPU/lifecycle behavior requires integration evidence.
- After tested checkpoints, update the relevant GitHub issues and project statuses with evidence and remaining gates. Close work only when its acceptance criteria are verified.
- Do not publish acceptance-game source, secrets or assets as part of 3JSN; use redistributable fixtures and capability reports.
