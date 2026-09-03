---
title: Claude is human too - how to organize CLAUDE.md so agents remember
description: Agents forget. What to cut, what to split out, and how to test whether an agent actually recalls it.
categories:
  - "[[Posts]]"
author:
  - "[[Me]]"
created: 2026-08-26
published: 2026-08-26
tags:
slug: organize-claude
share: true
modified: 2026-06-25T17:49:08.410+02:00
edited: 00:01:00
---
When you're working on a project for months, using AI coding agents, you notice all sorts of context issues. People claim it's forgetting things, misremembering. Which leads to all sorts of esoteric solutions, like treating it like a human, or like shit. (Don't conflate these in everyday life.)

Until you hear about the infamous CLAUDE.md. Suddenly a 1 Mio context limit isn't all that bad. Until you go deeper, and it's all that bad.


But did you hear about

PLAN.md?
BENCHMARK.md?
PROJECT_STATUS.md?
RESEARCH_FINDINGS.md?
XXX_REFERENCE.md?


But even then you'll land in the land of DRIFT, and it's got nothing to do with Japanese car culture. All your docs getting ready to backstab you despite carefully planning small chunks like you'd do with manual engineering.

You start accounting for DRIFT, update your CLAUDE.md to be an index, protect it with rules, what to do on new findings, etc.

But does it work?

You need interaction tests. Yes, *interaction tests*. How Claude will interact with the context and documentation structure you gave it.

The claims of not trusting code shifted to not trusting agents. Therefore, we should talk about tests. Test-driven-development is back. Just not how you expected.


Given my personal deep deep organizational systems around Obsidian I'm kinda excited that there's bleeding edge technology allowing me to apply all that knowledge in a totally new way.