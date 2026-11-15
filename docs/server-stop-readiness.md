# Server stop delivery

The gdzf log showed a Purpur command-source NullPointerException on the first
tick after startup. Its later successful stop was entered manually by the user.
The existing host already sent `stop\n`; `/stop` in this log was not evidence
that SLH added a slash.

Java stop requests now wait for the existing readiness marker before being
written to stdin. The host reports stopping while waiting and stays in that
state until the child exits. Repeated readiness lines do not resend the pending
command; an explicit later command can retry. Native Horizon does not wait for
Java readiness. No timeout forcibly terminates a saving server.

Console input strips an optional leading slash and outer whitespace, preserves
arguments and rejects embedded newlines. stdin write failures are reported by
the control API instead of being silently discarded.

The host regression launches an isolated child process that fails if it receives
any command before readiness, accepts exactly `stop\n` afterwards, and must exit
successfully. This verifies the actual host/control/stdin path without starting
or modifying a user's Minecraft server. No real world was opened in validation.
