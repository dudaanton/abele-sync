import { expect, it, vi } from 'vitest'
import { NetworkControl } from './fixture.js'

it('fails on excess HTTP work independently of runner speed', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  try {
    const network = new NetworkControl()
    network.limitRequests(2)
    await network.fetch('http://synthetic.test/one')
    await network.fetch('http://synthetic.test/two')
    await expect(network.fetch('http://synthetic.test/three')).rejects.toThrow(
      'acceptance HTTP work exceeded 2 requests'
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    fetch.mockRestore()
  }
})
