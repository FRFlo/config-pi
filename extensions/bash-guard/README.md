# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls and applies protection against destructive commands.

## Modes

### Default mode — disabled by default

Bash-guard starts disabled in the main session so normal agent work is not interrupted. The disabled mode still hard-blocks a small catastrophic floor. Run `/bash-guard` to enable interactive prompts for the current session, or start pi with `--bash-guard-enabled`.

When enabled, bash-guard:

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Prompts for **any** `git ...` command (escalates severity for especially risky ones: `git rm`,
  `git reset --hard`, `git clean -fdx`, `git push --force`, `git reflog expire`, `git gc --prune`)
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `curl|sh`/`wget|sh`, `kubectl delete`, `terraform destroy`,
  `aws s3 rm --recursive`, `gcloud delete`, shell redirections (`>`, `>>`, `2>`), pipes
- Shows a 2-option dialog: **Run** / **Abort**
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- `--bash-guard-enabled`: main-session flag that starts bash-guard with interactive prompts enabled.
- `--bash-guard-auto-allow`: allows flagged commands when there is no UI
  (e.g. running pi non-interactively).
