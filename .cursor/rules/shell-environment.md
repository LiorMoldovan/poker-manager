# Shell Environment Rule

## IMPORTANT: This is a Windows PowerShell Environment

This project runs on **Windows with PowerShell**. Do NOT use bash/Unix shell syntax.

## Prohibited Syntax (will fail)

- `&&` for command chaining - use `;` or run commands separately
- `<<'EOF'` heredoc syntax - not supported in PowerShell
- `$(command)` bash substitution in strings
- `cat`, `grep`, `sed`, `awk` Unix commands - use PowerShell equivalents or tool alternatives

## Correct Patterns

### Command Chaining
```powershell
# WRONG (bash)
git add . && git commit -m "message"

# CORRECT (PowerShell) - run as separate commands
git add .
git commit -m "message"
```

### Multi-line Commit Messages
```powershell
# WRONG (bash heredoc)
git commit -m "$(cat <<'EOF'
message
EOF
)"

# CORRECT - use simple single-line message
git commit -m "Short descriptive message"
```

### File Operations
- Use the Read tool instead of `cat`, `head`, `tail`
- Use the Grep tool instead of `grep` or `rg`
- Use the StrReplace tool instead of `sed` or `awk`
- Use the Write tool instead of `echo >` or heredocs

## Quick Reference

| Bash | PowerShell Alternative |
|------|----------------------|
| `&&` | `;` or separate commands |
| `cat file` | Use Read tool |
| `grep pattern` | Use Grep tool |
| `echo "text" > file` | Use Write tool |
