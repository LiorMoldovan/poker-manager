# Git Workflow

## Remote Repository

- **Remote**: GitHub (origin)
- **Branch**: `main`
- **Referred to as**: "BB" by the user (push to BB = push to GitHub)

## Before Pushing

Always check if remote has changes:
```powershell
git pull --rebase
```

If you have local uncommitted changes and need to pull:
```powershell
git stash
git pull --rebase
git stash pop
```

## Commit Messages

Keep commit messages concise. When updating version, use format:
```
v5.2.6 - Brief description of changes
```

## Common Push Rejection

If push fails with "fetch first" or "non-fast-forward":
1. Run `git pull --rebase`
2. Resolve any conflicts if needed
3. Run `git push` again

## Do NOT

- Force push to main
- Amend commits that have been pushed
- Change git config
