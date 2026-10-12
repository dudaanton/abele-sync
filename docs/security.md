# Security boundaries

Connection tokens are bearer secrets, not signatures or encrypted envelopes.
Base64 JSON/QR carries the address, a random 256-bit key and a display selector.
Keep tokens out of logs and screenshots. Local `user create` deliberately prints
a newly created root token; list operations never reveal existing keys/hashes.

The server stores only a pepper-keyed HMAC-SHA256 digest. Changing the pepper
invalidates keys. Use an independent high-entropy pepper and a 32-byte encryption
master key; protect them and the database/blob directory. Backup verification
authenticates and hashes every blob named by the snapshot.

Clients allow HTTPS, with HTTP only for literal loopback. Userinfo, query,
fragment and parser-ambiguous server addresses are rejected. The operator supplies
the canonical address during provisioning; request Host headers cannot set an
issued token's server. The key determines the authoritative space/scope; edited
JSON hints cannot expand authority.

Every v2 request authenticates before body handling/routing. Revoked keys and
disabled users receive `unauthorized`. Management mutations reauthenticate in
the transaction; PostgreSQL serializes these per space. A partial token can issue
only the same/contained selector. Inherited immutable boundaries are rechecked
against current identities; departure makes the connection unavailable and
hides the private destination. Cyclic directory/boundary data fails closed.

All valid tokens read and write; no reader role exists. Only the direct issuer
or an active `/` token in the same space can revoke. Revocation is direct only;
descendant policy remains an explicit question. Revocation/disconnection does
not delete local files.

The public app registers no legacy credential/access routes. Stage 1 does not
serve file/feed/commit/history/upload endpoints, so there is no claim yet of
partial-history, blob-by-hash, attachment publication or executable-review
coverage. Those boundaries must be verified against the numbered scenarios when
the corresponding APIs and host adapters land.
