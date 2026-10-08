# Local cross-instance sync

SLH v0.1 sync is local and portable. It does not claim cloud or cross-device state.

Mappings target canonical content under `data/shared` and select all current and future instances or an explicit list of instances. Directions are pull, push, or two-way. A mapping records strong hashes and its last successful snapshot.

Canonical folders are kept separate:

- `data/shared/options/options.txt`
- `data/shared/servers/servers.dat`
- `data/shared/resourcepacks/`
- `data/shared/screenshots/`
- `data/shared/mod-configs/`
- `data/shared/worlds/`

The shared library can be selected as the initial source before the first instance exists. Alternatively, an existing instance can seed a category. A mapping with the all-instances scope applies to instances that already exist and instances created, imported, or installed later.

Lifecycle:

1. After instance creation, import, or modpack installation, apply allowed shared content immediately.
2. Before launch, apply allowed shared content again.
3. Mark the instance running and stop modifying sensitive mapped content.
4. After game exit, compare source, target, and the last snapshot.
5. If both sides changed, create conflict copies and request a user choice.
6. Back up every overwrite and update the snapshot only after success.

The `Update now` action is optional. It exists for users who want an immediate refresh while Minecraft is closed; normal lifecycle synchronization does not require it.

World mappings are disabled by default. Enabling one requires an explicit warning, compatibility acknowledgment, backup policy, and confirmation that none of its target instances are running.
