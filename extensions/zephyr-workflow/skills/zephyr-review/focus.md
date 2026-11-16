# Focus hints by area kind

Pick by the area name or the paths of its files. Several can apply.

- **Kernel** (`kernel/`, `include/zephyr/kernel*`, `lib/os`): scheduler and thread lifecycle, ISR vs thread context, blocking in ISRs, spinlock/mutex/sem/condvar/workqueue/timer correctness, lock ordering, SMP races, timeouts, syscall verification, stack/heap sizing, public API Doxygen and `@version`.
- **Architecture / SoC** (`arch/`, `soc/`, `include/zephyr/arch/`): exception and interrupt paths, fatal error flow, context switch, inline asm constraints and clobbers, stack/ABI/red zone, cache and MMU/MPU, SMP bring-up, consistency with other arches against `include/zephyr/arch/arch_interface.h`, per-variant build impact, footprint.
- **Drivers** (`drivers/`, `include/zephyr/drivers/`): device model and init priority, `DT_INST_*` usage, API struct and error codes, ISR-safe paths, `pm_device`, DMA and cache coherency, locking, error-path cleanup, consistency with sibling drivers, `@retval` docs.
- **Subsystems / libraries** (`subsys/`, `lib/`, subsystem headers): API stability and versioning, migration guide and release notes, thread safety, buffer ownership and bounds, pools vs dynamic allocation, Kconfig structure, footprint.
- **Devicetree / Kconfig / CMake / boards / scripts**: binding schema, vendor prefixes, compatible naming, symbol naming, `select` vs `depends on`, undefined `CONFIG_` symbols, KeepSorted, CMake style on touched lines, board metadata, script lint.
- **Tests / samples** (meta areas): `tests.yaml` metadata, platform filters and skip comments, ztest usage, determinism, whether a test exercises the changed path and on which platforms, file-scope state, bsim script mode `100755`.
- **Documentation** (`doc/`): reStructuredText style, 100 columns, American English, migration-guide and release-notes rules in AGENTS.md, Doxygen completeness, cross-references.
