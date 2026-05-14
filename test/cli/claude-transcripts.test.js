import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadClaudeContextLookup } from '../../src/cli/claude-transcripts.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-claude-transcripts-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} project
 * @param {string} file
 * @param {Record<string, unknown>[]} rows
 * @returns {void}
 */
function writeTranscript(project, file, rows) {
  const dir = path.join(tmpDir, project)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

describe('loadClaudeContextLookup', function() {
  it('indexes only local context fields and returns the nearest row for a session timestamp', async function() {
    writeTranscript('-repo', 'sess.jsonl', [
      {
        type: 'user',
        sessionId: 'sess-1',
        timestamp: '2026-05-13T10:00:00.000Z',
        cwd: '/repo/old',
        gitBranch: 'old',
        version: '2.1.140',
        message: { role: 'user', content: 'not retained by lookup' },
      },
      {
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-05-13T10:10:00.000Z',
        cwd: '/repo/new',
        gitBranch: 'main',
        version: '2.1.141',
        toolUseResult: { stdout: 'not retained either' },
      },
    ])

    const lookup = await loadClaudeContextLookup({ projectsDir: tmpDir })
    expect(lookup('sess-1', '2026-05-13T10:09:00.000Z')).toEqual({
      cwd: '/repo/new',
      git_branch: 'main',
      claude_version: '2.1.141',
    })
    expect(lookup('missing', '2026-05-13T10:09:00.000Z')).toBeUndefined()
  })
})
