import { expect, it } from 'vitest'
import { parseGroupFrontmatter } from '../../src/scoped/groups/frontmatter.js'
it('parses only bounded leading groups YAML, never body links, aliases, tags or recursive over-budget structures', () => {
  expect(parseGroupFrontmatter('---\ngroups: ["[[Root]]"]\n---\n![[Private.png]]')).toEqual({
    status: 'valid',
    groups: ['[[Root]]'],
  })
  expect(parseGroupFrontmatter('body [[Private]]\n---\ngroups: ["[[Root]]"]')).toEqual({
    status: 'valid',
    groups: [],
  })
  for (const text of [
    '---\ngroups: {bad: yes}\n---',
    '---\na: &x ["[[Root]]"]\ngroups: *x\n---',
    '---\ngroups: !evil ["[[Root]]"]\n---',
  ])
    expect(parseGroupFrontmatter(text).status).toBe('invalid')
  expect(
    parseGroupFrontmatter(`---\ngroups: ${'['.repeat(40)}"Root"${']'.repeat(40)}\n---`).status
  ).toBe('limited')
  expect(parseGroupFrontmatter(`---\ngroups: ["${'x'.repeat(70000)}"]\n---`).status).toBe('limited')
})
