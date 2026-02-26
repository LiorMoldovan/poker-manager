# Testing Guidelines

## No Automated Tests

This project does not have automated tests. Testing is done manually by the user.

## Before Claiming Something Works

1. **Check for linter errors** using the ReadLints tool
2. **Verify logic** - trace through the code mentally
3. **Check for common issues**:
   - Variables used before declaration
   - Undefined references
   - Missing imports

## Common Bugs to Watch For

### Variable Hoisting
```typescript
// BUG: Using variable before it's defined
if (someCondition) {
  console.log(myVar); // ReferenceError!
}

const myVar = 'value'; // Defined too late
```

### Browser API Limits
- `AudioContext`: Max ~6 instances per page - reuse a shared instance
- `speechSynthesis`: May need to resume after page interaction

### PC vs Mobile Differences
- Native `<select>` dropdowns may show blank text on PC with CSS variables
- Test on both mobile and PC when touching UI elements

## When User Reports a Bug

1. Read the relevant code first
2. Check git history if needed (`git log -S "search term"`)
3. Fix the root cause, not just the symptom
4. Verify no linter errors after fix
