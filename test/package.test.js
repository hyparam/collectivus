import { describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

describe('package.json', () => {
  it('should have the correct name', () => {
    expect(packageJson.name).toBe('collectivus')
  })
  it('should have a valid version', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/)
  })
  it('should have MIT license', () => {
    expect(packageJson.license).toBe('MIT')
  })
  it('should have precise dependency versions', () => {
    const { dependencies, devDependencies } = packageJson
    Object.values({ ...dependencies, ...devDependencies }).forEach(version => {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    })
  })
  it('exposes ctvs and collectivus binaries', () => {
    expect(packageJson.bin).toMatchObject({
      ctvs: 'bin/cli.js',
      collectivus: 'bin/cli.js',
    })
  })
  it('should have direct query dependencies', () => {
    expect(packageJson.dependencies).toMatchObject({
      hyparquet: '1.25.8',
      'hyparquet-compressors': '1.1.1',
      squirreling: '0.12.19',
    })
  })
})
