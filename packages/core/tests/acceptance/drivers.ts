import { expect } from 'vitest'
import { decodeAccessToken } from '@abele/sync-protocol'
import { AccessClient } from '../../src/index.js'
import type { AcceptanceFixture } from './fixture.js'

export const stage1ServerFacets = new Set([1, 4, 7, 9, 11, 16, 17, 18, 19, 20, 21])
const denied = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject({ code })
}
export async function serverFacet(number: number, fixture: AcceptanceFixture) {
  const server = fixture.servers[0]!,
    root = fixture.roots[0]!,
    a = fixture.devices[0]!,
    b = fixture.devices[1]!
  const owner = AccessClient.fromToken(root.token, { fetch })
  const scope = { kind: root.info.scope.kind, id: root.info.scope.id }
  const issue = (client = owner, selector = scope) =>
    client.issue({ scope: selector, label: 'Synthetic share' })
  const shared = async () => {
    const spaceId = (await owner.connection()).space_id
    await server.db
      .insertInto('directories')
      .values({
        id: 'shared',
        space_id: spaceId,
        parent_id: scope.id,
        path: 'Shared',
        deleted_at: null,
        version_id: 'shared-v',
        mtime: 0,
      })
      .execute()
    const token = await issue(owner, { kind: 'folder', id: 'shared' })
    return { issued: token, client: AccessClient.fromToken(token.token, { fetch }) }
  }
  switch (number) {
    case 1: {
      expect(await server.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
      expect(await server.db.selectFrom('spaces').selectAll().execute()).toHaveLength(1)
      expect((await owner.connection()).scope).toEqual(root.info.scope)
      expect(root.info.scope.path).toBe('/')
      return
    }
    case 4: {
      const peer = AccessClient.fromToken(fixture.roots[1]!.token, { fetch })
      expect((await owner.connection()).status).toBe('active')
      expect((await peer.connection()).status).toBe('active')
      expect(
        (await issue(peer, { kind: 'folder', id: fixture.roots[1]!.info.scope.id })).info.scope.path
      ).toBe('/')
      return
    }
    case 7: {
      await a.write('Existing.md', 'unchanged')
      const before = [...a.connections.keys()]
      await expect(a.paste('broken base64', 'broken')).rejects.toThrow(/token/i)
      expect([...a.connections.keys()]).toEqual(before)
      expect(await a.text('Existing.md')).toBe('unchanged')
      return
    }
    case 9: {
      const token = await issue()
      await owner.revoke(token.info.id)
      const before = [...a.connections.keys()]
      await denied(a.paste(token.token, 'revoked'), 'unauthorized')
      expect([...a.connections.keys()]).toEqual(before)
      expect(a.network.requests.at(-1)?.url).toContain('/v2/connection')
      return
    }
    case 11: {
      const second = await a.issue('server-1', scope, 'Second device')
      expect(decodeAccessToken(second.token).key).not.toBe(
        decodeAccessToken(a.connection('server-1').token).key
      )
      expect(second.info.scope).toEqual(root.info.scope)
      expect(await server.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
      return
    }
    case 16: {
      const guest = await shared()
      const next = await issue(guest.client, { kind: 'folder', id: 'shared' })
      await b.paste(next.token, 'delegated')
      expect((await b.connection('delegated').access.connection()).scope.path).toBe('Shared')
      expect(await server.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
      return
    }
    case 17: {
      const guest = await shared()
      await denied(issue(guest.client), 'forbidden')
      await denied(issue(guest.client, { kind: 'folder', id: 'other' }), 'forbidden')
      const tampered = {
        ...decodeAccessToken(guest.issued.token),
        scope: { kind: 'folder' as const, id: scope.id, path: '/' },
      }
      const connection = await new AccessClient(tampered, { fetch }).connection()
      expect(connection.scope.id).toBe('shared')
      return
    }
    case 18: {
      const guest = await shared()
      await owner.revoke(guest.issued.info.id)
      await denied(guest.client.connection(), 'unauthorized')
      await denied(issue(guest.client, { kind: 'folder', id: 'shared' }), 'unauthorized')
      const response = await fetch(server.address + '/v2/commit', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${decodeAccessToken(guest.issued.token).key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ops: [] }),
      })
      expect(response.status).toBe(401)
      return
    }
    case 19: {
      const guest = await shared()
      const child = await issue(guest.client, { kind: 'folder', id: 'shared' })
      // This root token did not issue either partial token.
      await b.revoke('server-1', child.info.id)
      await denied(AccessClient.fromToken(child.token, { fetch }).connection(), 'unauthorized')
      return
    }
    case 20: {
      const guest = await shared()
      const peer = await issue(owner, { kind: 'folder', id: 'shared' })
      const peerClient = AccessClient.fromToken(peer.token, { fetch })
      const child = await issue(guest.client, { kind: 'folder', id: 'shared' })
      await denied(peerClient.revoke(child.info.id), 'forbidden')
      expect((await peerClient.tokens()).items).toEqual([])
      expect((await guest.client.tokens()).items.map((token) => token.id)).toContain(child.info.id)
      await guest.client.revoke(child.info.id)
      await denied(AccessClient.fromToken(child.token, { fetch }).connection(), 'unauthorized')
      return
    }
    case 21: {
      const guest = await shared()
      const descendant = await issue(guest.client, { kind: 'folder', id: 'shared' })
      await owner.revoke(guest.issued.info.id)
      await denied(guest.client.connection(), 'unauthorized')
      expect((await AccessClient.fromToken(descendant.token, { fetch }).connection()).status).toBe(
        'active'
      )
      // Also retain refreshed scenario 21a's independent own-device-token assertion.
      const one = await a.connection('server-1').access.connection()
      await owner.revoke(one.token_id)
      await denied(a.connection('server-1').access.connection(), 'unauthorized')
      expect((await b.connection('server-1').access.connection()).status).toBe('active')
      expect((await a.connection('server-2').access.connection()).status).toBe('active')
      return
    }
    default:
      throw new Error(`No stage-1 server facet for scenario ${number}`)
  }
}

/** Plugin-owned platform verification, not evidence collected by this repository.
 * README forbids silently skipping pending numbers, so all eight retain it.fails. */
export const platformScenarioReasons: Readonly<Record<number, string>> = {
  117: 'Obsidian iPhone token input and physical-camera QR scan; core token/decoded-payload facets are 2–3',
  118: 'Obsidian iPhone filesystem/watch CRUD and return delivery; core file/directory facets are 43–56 and 69–73',
  119: 'iOS suspension/foreground lifecycle resumes the plugin; physical backgrounding is not a core engine operation',
  120: 'iOS native transport reacts to Wi-Fi/cellular loss and handover; core offline/retry facets are 101–102',
  121: 'iPhone note-open attachment consent dialog, deliberate allow/deny; core authorization facets are 76–82',
  122: 'iPhone script-review dialog displays connection, observation time and exact bytes, then approves/rejects; core staging facets are 85–90',
  123: 'iPhone UI locates conflict variants and displays the refused path/reason; core outcomes are 91–100 and 104–106',
  124: 'iPhone simultaneous plugin connection coordination with one native transport offline; core two-server forwarding/retry facets are 27–31 and 102',
}

export async function pendingScenario(number: number): Promise<void> {
  const reason = platformScenarioReasons[number]
  if (reason === undefined) throw new Error(`Missing server/core facet for scenario ${number}`)
  throw new Error(`${String(number).padStart(3, '0')} PLATFORM EVIDENCE PENDING: ${reason}`)
}
