-- Store a cache entry only if it is newer than what the cache already knows.
-- KEYS[1] cache key   ARGV[1] version (a row version or commit timestamp)
-- ARGV[2] 'value' or 'marker'   ARGV[3] payload   ARGV[4] TTL in ms
-- Readers call it with 'value' after a miss; writers call it with 'marker' after a commit,
-- instead of DEL, so a slow reader holding an older row cannot fill over the write.
local current = redis.call('HMGET', KEYS[1], 'version', 'kind')
local version = tonumber(ARGV[1])
if current[1] then
  local known = tonumber(current[1])
  if version < known or (version == known and current[2] == 'value') then
    return 0 -- refused: the cache already has this version or a newer one
  end
end
redis.call('HSET', KEYS[1], 'version', version, 'kind', ARGV[2], 'payload', ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1
