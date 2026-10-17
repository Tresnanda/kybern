#!/bin/sh
# remote9 visual fixture `ssh` (KYBERN_SSH for the remote9 screens): no network, behaviour chosen by the machine.
case " $* " in
  *perm.example*) cat >/dev/null; echo "dev@perm.example: Permission denied (publickey)." >&2; exit 255 ;;
  *closed.example*) cat >/dev/null; echo "ssh: connect to host closed.example port 22: Connection refused" >&2; exit 255 ;;
  *" -N "*) exec sleep 45 ;; # the tunnel never opens: "Start the daemon" stays in progress
  *) cat >/dev/null; printf 'os=Linux\narch=x86_64\nkybernd=/home/dev/.local/bin/kybernd\nversion=0.9.1\ncurl=1\nport=4173\ntoken=visual-fixture\n' ;;
esac
