# Repository References

Repository References lets a Pi agent consult source code from Git repositories outside its active project without treating those repositories as part of the project being changed.

## Language

**Repository Reference**:
A named, read-only view of a Git repository that an agent can browse while working in another project.
_Avoid_: External directory, dependency checkout

**Alias**:
The lowercase name of a Repository Reference, written with an `@` prefix when used in a prompt or tool path.
_Avoid_: Reference name, mount name

**Local Reference**:
A Repository Reference backed directly by an existing non-bare Git working tree, including its current tracked and untracked state.
_Avoid_: Local cache

**Remote Reference**:
A Repository Reference backed by a disposable Managed Checkout materialized from a Git remote.
_Avoid_: Cloned dependency

**Managed Checkout**:
The shared, disposable working tree maintained for a Remote Reference at its configured revision.
_Avoid_: Working copy

**Description**:
Optional guidance that explains what a Repository Reference contains and when the agent should consult it. A Description makes the reference proactively discoverable to the agent.
_Avoid_: Documentation, label

**Refresh Policy**:
The rule that determines when a Remote Reference checks its Git remote for updated source: once per session, after a time-to-live, or only on explicit request.
_Avoid_: Update schedule
