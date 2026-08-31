# How to Use PROJECT_MASTER_REFERENCE.md

## For Users
Read this file whenever you want to understand:
- What's already built (don't ask Claude to rebuild it)
- What's currently being worked on
- What's planned for future phases
- Which endpoints and features are live

## For AI Agents/Claude Sessions
**Before suggesting ANY work:**
1. Read `PROJECT_MASTER_REFERENCE.md` first
2. Check if feature is in Phase 1 ✅ COMPLETE → Skip suggestion
3. Check if feature is in Phase 2 🔄 IN PROGRESS → Include in current work only
4. Check if feature is in Phase 3 📋 PLANNED → Explicitly exclude from suggestions

**When uncertain about scope:**
- Check "DO NOT" section → Prevents duplicate work
- Check "Current Priorities" section → Focuses on what matters now
- Check "Key Files" section → Know what code to modify

**When planning next steps:**
- Follow the "Next After Dashboard Integration" list
- Don't jump to Phase 3 features
- Reference success criteria before claiming completion

## Key Sections for Quick Lookup

### "What's Already Working" (Phase 1)
Use this to verify features before suggesting they're built:
- ✅ All 48 API endpoints working
- ✅ All webhooks live and receiving events
- ✅ Database connected
- ✅ E2E testing completed

### "What Needs to Be Done" (Phase 2)
Use this for current sprint work:
- Dashboard API integration
- Real-time metric updates
- Form submission handling
- Error handling

### "Important Constraints"
Critical! Check these before:
- ❌ DO NOT add Phase 3 features
- ❌ DO NOT modify Phase 1 code
- ✅ DO focus on dashboard API integration ONLY

## How It Gets Updated

### When to Update This Document
1. **After completing a Phase 2 task** - Mark as ✅ complete
2. **When discovering new info** - Add to appropriate section
3. **When changing priorities** - Update "Current Priorities"
4. **Never during session** - Only between sessions to save tokens

### How to Update
```bash
# Edit the file
git add PROJECT_MASTER_REFERENCE.md
git commit -m "Update PROJECT_MASTER_REFERENCE.md - [what changed]"
git push
```

## Example: Preventing Duplicate Work

**Bad Scenario:**
```
User: Build campaign management
Claude: I'll add POST /api/campaigns endpoint
User: That's already built!
Claude: Sorry, wasted effort
```

**Good Scenario (with Master Reference):**
```
Claude: (reads master reference)
Claude: Campaign management is Phase 1 complete ✅
Claude: Endpoints POST /api/campaigns already working
Claude: Moving to Phase 2: Dashboard integration
Claude: Task: Connect campaign form to existing /api/campaigns endpoint
User: Perfect, exactly what we need
```

## For Context-Limited Sessions

When starting a new session with limited context:
1. First thing: Read `PROJECT_MASTER_REFERENCE.md`
2. This replaces all previous chat history
3. You'll know exactly what's done and what's planned
4. Continue from "Current Priorities" section

---

## Real Example: Using This Guide

**Scenario:** New session starts, wants to avoid waste

1. ✅ **Read Master Reference** → Learns Phase 1 complete, Phase 2 in progress
2. ✅ **Check dashboard section** → Sees "API Integration In Progress 🔄"
3. ✅ **Checks "What Needs to Be Done"** → Sees exact TODO list
4. ✅ **Avoids** → Doesn't suggest webhook modifications (Phase 1)
5. ✅ **Focuses** → Works on dashboard API integration only
6. ✅ **Success** → Completes intended Phase 2 work without waste

---

## Checklist: Before Suggesting Any Work

- [ ] Have I read `PROJECT_MASTER_REFERENCE.md`?
- [ ] Is this in Phase 1? If yes → skip, already done
- [ ] Is this in Phase 2? If yes → include in current work
- [ ] Is this in Phase 3? If yes → explicitly exclude from suggestions
- [ ] Does "Important Constraints" say NOT to do this? If yes → skip
- [ ] Is this in "Current Priorities"? If yes → high priority
- [ ] Have I checked "Key Files" to know what to modify?

If all above are confirmed, proceed with work.

---

**TL;DR:** This master reference prevents waste. Read it first. Follow its scope. Don't re-suggest completed work.
