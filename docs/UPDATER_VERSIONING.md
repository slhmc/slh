# Launcher release versions

Cargo, npm and Tauri require SemVer with three numeric components. Encode
additional public numeric components as numeric build metadata: public
`0.2.2.1.2.3` is stored as `0.2.2+1.2.3` in package and Tauri metadata. For a
prerelease, public `0.2.2.1-rc.1` is stored as `0.2.2-rc.1+1`.

Release scripts generate public tags and filenames from this encoding; the
signed updater manifest retains the valid SemVer form. SLH's update detector
and updater plugin compare the numeric components and prerelease correctly.
Other, nonnumeric SemVer build metadata remains informational. Do not encode
multiple unrelated numeric identifiers as build metadata: they are interpreted
as version components. Use nonnumeric metadata for build identifiers.

Clients released before the extended comparator still use ordinary SemVer and
cannot detect a new version differing only in metadata. Ship a transition
release with a greater three-part version, or update those clients manually.
Windows MSI and platform package managers have their own version restrictions;
validate upgrades for the chosen installer and platform before publishing.
