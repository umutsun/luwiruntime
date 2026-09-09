import { createHash } from 'node:crypto';

import type { RedisFunctionRegistry } from './function-registry.js';

export type RedisFunctionLibrary = {
  registry: RedisFunctionRegistry;
  source: string;
  contentHash: string;
};

function register(functionName: string, callback: string): string {
  return `redis.register_function{function_name='${functionName}', callback=${callback}}`;
}

export function buildFunctionLibrary(registry: RedisFunctionRegistry): RedisFunctionLibrary {
  const source = [
    `#!lua name=${registry.libraryName}`,
    'local function key_type(key)',
    "  local result = redis.call('TYPE', key)",
    "  if type(result) == 'table' then return result['ok'] end",
    '  return result',
    'end',
    'local function type_is(key, expected)',
    '  local actual = key_type(key)',
    "  return actual == 'none' or actual == expected",
    'end',
    'local function stream_appendable(key)',
    "  if key_type(key) == 'none' then return true end",
    "  local info = redis.call('XINFO', 'STREAM', key)",
    '  for index = 1, #info, 2 do',
    "    if info[index] == 'last-generated-id' then",
    "      return info[index + 1] ~= '18446744073709551615-18446744073709551615'",
    '    end',
    '  end',
    '  return false',
    'end',
    "local MAX_STREAM_PART = '18446744073709551615'",
    'local STREAM_SEQ_HEADROOM = {',
    "  ['1'] = '18446744073709551614',",
    "  ['2'] = '18446744073709551613',",
    "  ['3'] = '18446744073709551612',",
    "  ['4'] = '18446744073709551611'",
    '}',
    '-- Capacity for `needed` further appends, not merely for one. A stream whose',
    '-- last id is within n-1 of the maximum passes stream_appendable, accepts the',
    '-- first append and rejects the next, leaving a projection without its event.',
    'local function stream_has_capacity(key, needed)',
    "  if key_type(key) == 'none' then return true end",
    "  local info = redis.call('XINFO', 'STREAM', key)",
    '  local last = nil',
    '  for index = 1, #info, 2 do',
    "    if info[index] == 'last-generated-id' then last = info[index + 1] end",
    '  end',
    '  if last == nil then return false end',
    "  local ms, seq = string.match(last, '^(%d+)%-(%d+)$')",
    '  if ms == nil then return false end',
    '  -- Below the final millisecond Redis rolls over to ms+1, so room remains.',
    '  if #ms < #MAX_STREAM_PART or ms ~= MAX_STREAM_PART then return true end',
    '  local threshold = STREAM_SEQ_HEADROOM[tostring(needed)]',
    '  if threshold == nil then return false end',
    '  if #seq < #threshold then return true end',
    '  if #seq > #threshold then return false end',
    '  return seq <= threshold',
    'end',
    '-- Validates only. Any mutation here would break "a conflict writes nothing",',
    '-- and it runs before XGROUP CREATE, which itself creates a stream.',
    'local function native_validate(binding_key, link_key, stale_key, native, session_id, declared)',
    "  local function is_id(value) return type(value) == 'string' and value ~= '' end",
    "  if type(native) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "  if not is_id(native.bindingId) then return 'REDIS_ARGUMENT_INVALID' end",
    "  if type(native.link) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "  if not is_id(native.link.id) or not is_id(native.link.sessionId) then return 'REDIS_ARGUMENT_INVALID' end",
    '  local expected_version = tonumber(native.expectedVersion)',
    '  if not expected_version or expected_version < 0 or expected_version ~= math.floor(expected_version) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    '  -- The caller declares the identifiers its keys were built from, separately',
    '  -- from the payload written into them. Comparing the payload against itself',
    '  -- would prove nothing: a key built from one id could hold a record naming',
    '  -- another. A Function may not derive a key name, so this is the only place',
    '  -- the two can be tied together.',
    "  if type(declared) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "  if not is_id(declared.bindingId) or not is_id(declared.linkId) then return 'REDIS_ARGUMENT_INVALID' end",
    '  if declared.staleLinkId ~= nil and not is_id(declared.staleLinkId) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  if native.bindingId ~= declared.bindingId then return 'REDIS_ARGUMENT_INVALID' end",
    "  if native.link.id ~= declared.linkId then return 'REDIS_ARGUMENT_INVALID' end",
    '  if (native.staleLinkId or false) ~= (declared.staleLinkId or false) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  if native.link.sessionId ~= session_id then return 'REDIS_ARGUMENT_INVALID' end",
    '  if native.expectedOpenLinkId ~= nil and not is_id(native.expectedOpenLinkId) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    '  if native.staleLinkId ~= nil and not is_id(native.staleLinkId) then',
    "    return 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  local exists = key_type(binding_key) ~= 'none'",
    '  if expected_version == 0 then',
    "    if exists then return 'VERSION_CONFLICT' end",
    "    if type(native.binding) ~= 'table' then return 'REDIS_ARGUMENT_INVALID' end",
    "    if native.binding.id ~= native.bindingId then return 'REDIS_ARGUMENT_INVALID' end",
    "    if native.staleLinkId ~= nil then return 'REDIS_ARGUMENT_INVALID' end",
    '  else',
    "    if not exists then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', binding_key, 'id') ~= native.bindingId then return 'VERSION_CONFLICT' end",
    "    local stored_version = tonumber(redis.call('HGET', binding_key, 'version'))",
    "    local stored_open = redis.call('HGET', binding_key, 'openLinkId')",
    "    if stored_version ~= expected_version then return 'VERSION_CONFLICT' end",
    '    if (stored_open or false) ~= (native.expectedOpenLinkId or false) then',
    "      return 'VERSION_CONFLICT'",
    '    end',
    '  end',
    '  if native.staleLinkId then',
    "    if key_type(stale_key) ~= 'hash' then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'id') ~= native.staleLinkId then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'bindingId') ~= native.bindingId then return 'VERSION_CONFLICT' end",
    "    if redis.call('HGET', stale_key, 'unlinkedAt') then return 'VERSION_CONFLICT' end",
    '  end',
    '  -- An existing link key means this (binding, session) pair was linked before;',
    '  -- overwriting it would silently discard an earlier interval.',
    "  if key_type(link_key) ~= 'none' then return 'VERSION_CONFLICT' end",
    '  return nil',
    'end',
    'local function native_apply(binding_key, link_key, links_key, reverse_key, stale_key, native, clock, unlinked_event_id, workspace_id)',
    '  local unlinked_event = nil',
    '  if native.staleLinkId then',
    "    redis.call('HSET', stale_key, 'unlinkedAt', clock.timestamp)",
    '    unlinked_event = {',
    "      id=unlinked_event_id, version=1, type='session.native.unlinked',",
    '      occurredAt=clock.timestamp, workspaceId=workspace_id,',
    '      payload={bindingId=native.bindingId, linkId=native.staleLinkId}',
    '    }',
    '  end',
    "  redis.call('HSET', link_key, 'id', native.link.id, 'bindingId', native.bindingId, 'sessionId', native.link.sessionId, 'linkedAt', clock.timestamp)",
    "  redis.call('ZADD', links_key, clock.milliseconds, native.link.id)",
    "  redis.call('SET', reverse_key, native.bindingId)",
    '  if tonumber(native.expectedVersion) == 0 then',
    "    redis.call('HSET', binding_key, 'id', native.binding.id, 'adapterId', native.binding.adapterId, 'nativeSessionId', native.binding.nativeSessionId, 'kind', native.binding.kind, 'version', 1, 'linkCount', 1, 'trimmedLinkCount', 0, 'firstLinkedAt', clock.timestamp, 'lastLinkedAt', clock.timestamp, 'openLinkId', native.link.id)",
    "    if native.binding.nativeSubagentId then redis.call('HSET', binding_key, 'nativeSubagentId', native.binding.nativeSubagentId) end",
    "    if native.binding.parentRefJson then redis.call('HSET', binding_key, 'parentRef', native.binding.parentRefJson) end",
    '  else',
    "    redis.call('HSET', binding_key, 'openLinkId', native.link.id, 'lastLinkedAt', clock.timestamp)",
    "    redis.call('HINCRBY', binding_key, 'linkCount', 1)",
    "    redis.call('HINCRBY', binding_key, 'version', 1)",
    '  end',
    '  return unlinked_event',
    'end',
    '-- HSET creates a missing hash, so the unlink proves the link is the one it',
    '-- means before writing, and refuses a second close so unlinkedAt is written once.',
    'local function native_unlink(binding_key, link_key, native, session_id, clock, event_id, workspace_id)',
    "  if type(native) ~= 'table' then return nil, 'REDIS_ARGUMENT_INVALID' end",
    "  if type(session_id) ~= 'string' or session_id == '' then return nil, 'REDIS_ARGUMENT_INVALID' end",
    '  local expected_version = tonumber(native.expectedVersion)',
    '  if not expected_version or expected_version < 0 or expected_version ~= math.floor(expected_version) then',
    "    return nil, 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  if type(native.bindingId) ~= 'string' or type(native.linkId) ~= 'string' then",
    "    return nil, 'REDIS_ARGUMENT_INVALID'",
    '  end',
    "  if key_type(binding_key) == 'none' then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', binding_key, 'id') ~= native.bindingId then return nil, 'VERSION_CONFLICT' end",
    "  local stored_version = tonumber(redis.call('HGET', binding_key, 'version'))",
    "  local stored_open = redis.call('HGET', binding_key, 'openLinkId')",
    "  if stored_version ~= expected_version then return nil, 'VERSION_CONFLICT' end",
    '  if (stored_open or false) ~= (native.expectedOpenLinkId or false) then',
    "    return nil, 'VERSION_CONFLICT'",
    '  end',
    "  if key_type(link_key) ~= 'hash' then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'id') ~= native.linkId then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'bindingId') ~= native.bindingId then return nil, 'VERSION_CONFLICT' end",
    '  -- The link must belong to the session being made terminal. Without this,',
    "  -- closing one session would close another session's open interval and",
    '  -- leave that session alive with no link.',
    "  if redis.call('HGET', link_key, 'sessionId') ~= session_id then return nil, 'VERSION_CONFLICT' end",
    "  if redis.call('HGET', link_key, 'unlinkedAt') then return nil, 'VERSION_CONFLICT' end",
    "  redis.call('HSET', link_key, 'unlinkedAt', clock.timestamp)",
    "  redis.call('HDEL', binding_key, 'openLinkId')",
    "  redis.call('HINCRBY', binding_key, 'version', 1)",
    '  return {',
    "    id=event_id, version=1, type='session.native.unlinked', occurredAt=clock.timestamp,",
    '    workspaceId=workspace_id,',
    '    payload={bindingId=native.bindingId, linkId=native.linkId}',
    '  }, nil',
    'end',
    'local function redis_now()',
    "  local now = redis.call('TIME')",
    '  local seconds = tonumber(now[1])',
    '  local milliseconds = math.floor(tonumber(now[2]) / 1000)',
    '  local days = math.floor(seconds / 86400)',
    '  local seconds_of_day = seconds - (days * 86400)',
    '  local era = math.floor(days / 146097)',
    '  local day_of_era = days - (era * 146097) + 719468',
    '  era = math.floor(day_of_era / 146097)',
    '  day_of_era = day_of_era - (era * 146097)',
    '  local year_of_era = math.floor((day_of_era - math.floor(day_of_era / 1460) + math.floor(day_of_era / 36524) - math.floor(day_of_era / 146096)) / 365)',
    '  local year = year_of_era + (era * 400)',
    '  local day_of_year = day_of_era - ((365 * year_of_era) + math.floor(year_of_era / 4) - math.floor(year_of_era / 100))',
    '  local month_prime = math.floor(((5 * day_of_year) + 2) / 153)',
    '  local day = day_of_year - math.floor(((153 * month_prime) + 2) / 5) + 1',
    '  local month',
    '  if month_prime < 10 then month = month_prime + 3 else month = month_prime - 9 end',
    '  if month <= 2 then year = year + 1 end',
    '  local hour = math.floor(seconds_of_day / 3600)',
    '  local minute = math.floor((seconds_of_day % 3600) / 60)',
    '  local second = seconds_of_day % 60',
    "  return {timestamp=string.format('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ', year, month, day, hour, minute, second, milliseconds), milliseconds=(seconds * 1000) + milliseconds}",
    'end',
    'local function iso_from_milliseconds(epoch_milliseconds)',
    '  local seconds = math.floor(epoch_milliseconds / 1000)',
    '  local milliseconds = epoch_milliseconds - (seconds * 1000)',
    '  local days = math.floor(seconds / 86400)',
    '  local seconds_of_day = seconds - (days * 86400)',
    '  local era = math.floor(days / 146097)',
    '  local day_of_era = days - (era * 146097) + 719468',
    '  era = math.floor(day_of_era / 146097)',
    '  day_of_era = day_of_era - (era * 146097)',
    '  local year_of_era = math.floor((day_of_era - math.floor(day_of_era / 1460) + math.floor(day_of_era / 36524) - math.floor(day_of_era / 146096)) / 365)',
    '  local year = year_of_era + (era * 400)',
    '  local day_of_year = day_of_era - ((365 * year_of_era) + math.floor(year_of_era / 4) - math.floor(year_of_era / 100))',
    '  local month_prime = math.floor(((5 * day_of_year) + 2) / 153)',
    '  local day = day_of_year - math.floor(((153 * month_prime) + 2) / 5) + 1',
    '  local month',
    '  if month_prime < 10 then month = month_prime + 3 else month = month_prime - 9 end',
    '  if month <= 2 then year = year + 1 end',
    '  local hour = math.floor(seconds_of_day / 3600)',
    '  local minute = math.floor((seconds_of_day % 3600) / 60)',
    '  local second = seconds_of_day % 60',
    "  return string.format('%04d-%02d-%02dT%02d:%02d:%02d.%03dZ', year, month, day, hour, minute, second, milliseconds)",
    'end',
    '-- Retention, not a transition: no event, no stream key, no product policy.',
    '-- Every key arrives paired with the identity it must hold, because a',
    '-- Function may not derive a key name and a key on its own proves nothing',
    '-- about what is inside it.',
    'local function native_link_trim(keys, args)',
    '  local pair_count = #keys - 2',
    '  if pair_count < 2 or pair_count > 64 or pair_count % 2 ~= 0 or #args ~= 2 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local count = pair_count / 2',
    '  local expected_version = tonumber(args[1])',
    '  if not expected_version or expected_version < 1 or expected_version ~= math.floor(expected_version) then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local decoded_ok, declared = pcall(cjson.decode, args[2])',
    "  if not decoded_ok or type(declared) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(declared.bindingId) ~= 'string' or declared.bindingId == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(declared.links) ~= 'table' or #declared.links ~= count then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local seen = {}',
    '  for index = 1, count do',
    '    local entry = declared.links[index]',
    "    if type(entry) ~= 'table' or type(entry.id) ~= 'string' or entry.id == '' or type(entry.sessionId) ~= 'string' or entry.sessionId == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    if seen[entry.id] then',
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    seen[entry.id] = true',
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'zset') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '  end',
    "  if redis.call('HGET', keys[1], 'id') ~= declared.bindingId then",
    "    return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '  end',
    "  if tonumber(redis.call('HGET', keys[1], 'version')) ~= expected_version then",
    "    return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '  end',
    "  local open_link_id = redis.call('HGET', keys[1], 'openLinkId')",
    '  -- Validation runs to completion before the first removal, which is what',
    '  -- makes every refusal below leave the binding exactly as it was.',
    '  for index = 1, count do',
    '    local entry = declared.links[index]',
    '    local link_key = keys[1 + (index * 2)]',
    '    local reverse_key = keys[2 + (index * 2)]',
    '    if open_link_id and entry.id == open_link_id then',
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if key_type(link_key) ~= 'hash' then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if redis.call('HGET', link_key, 'id') ~= entry.id then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if redis.call('HGET', link_key, 'bindingId') ~= declared.bindingId then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if redis.call('HGET', link_key, 'sessionId') ~= entry.sessionId then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    '    -- An open link is never trimmed. `openLinkId` is a pointer that can go',
    '    -- stale; the record itself cannot lie about being closed.',
    "    if not redis.call('HGET', link_key, 'unlinkedAt') then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if not redis.call('ZSCORE', keys[2], entry.id) then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if key_type(reverse_key) ~= 'string' then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    "    if redis.call('GET', reverse_key) ~= declared.bindingId then",
    "      return cjson.encode({status='error', code='VERSION_CONFLICT'})",
    '    end',
    '  end',
    '  for index = 1, count do',
    '    local entry = declared.links[index]',
    "    redis.call('ZREM', keys[2], entry.id)",
    "    redis.call('DEL', keys[1 + (index * 2)])",
    "    redis.call('DEL', keys[2 + (index * 2)])",
    '  end',
    "  local trimmed_total = redis.call('HINCRBY', keys[1], 'trimmedLinkCount', count)",
    "  local version = redis.call('HINCRBY', keys[1], 'version', 1)",
    "  local oldest = redis.call('ZRANGE', keys[2], 0, 0, 'WITHSCORES')",
    '  local oldest_retained = nil',
    '  if oldest and oldest[2] then',
    '    oldest_retained = iso_from_milliseconds(tonumber(oldest[2]))',
    "    redis.call('HSET', keys[1], 'oldestRetainedLinkedAt', oldest_retained)",
    '  else',
    "    redis.call('HDEL', keys[1], 'oldestRetainedLinkedAt')",
    '  end',
    "  local result = {status='trimmed', trimmed=count, version=version, trimmedLinkCount=trimmed_total}",
    '  if oldest_retained then result.oldestRetainedLinkedAt = oldest_retained end',
    '  return cjson.encode(result)',
    'end',
    'local function append_event(global_stream, project_stream, event_json)',
    "  local global_stream_id = redis.call('XADD', global_stream, '*', 'event', event_json)",
    "  local project_stream_id = redis.call('XADD', project_stream, '*', 'event', event_json)",
    '  return {globalStreamId=global_stream_id, projectStreamId=project_stream_id}',
    'end',
    `-- Bridge state is public JSON in a retained hash. Only the separate string
-- key contains a private owner token. Validation helpers never mutate Redis.
local BRIDGE_TTL = 15000
local MAX_SAFE_INTEGER = 9007199254740991
local function bridge_id(value)
  return type(value) == 'string' and #value > 0 and #value <= 128 and string.match(value, '^[A-Za-z0-9][A-Za-z0-9._:-]*$') ~= nil
end
local function bridge_digest(value)
  return type(value) == 'string' and #value == 64 and string.match(value, '^[a-f0-9]+$') ~= nil
end
local function bridge_profile(value)
  return (value.provider == 'codex' or value.provider == 'claude-code' or value.provider == 'gemini-cli' or value.provider == 'antigravity') and (value.executionProfile == 'read-only' or value.executionProfile == 'workspace-write')
end
local function bridge_integer(value, minimum)
  return type(value) == 'number' and value >= minimum and value <= MAX_SAFE_INTEGER and value == math.floor(value)
end
local function bridge_token(value)
  return type(value) == 'string' and #value > 0 and #value <= 256 and string.match(value, '^%s') == nil and string.match(value, '%s$') == nil
end
local function bridge_error(code) return cjson.encode({status='error', code=code}) end
local function bridge_reserved(metadata)
  return metadata.bridge ~= nil or metadata.bridgeSlotId ~= nil or metadata.provider ~= nil or metadata.executionProfile ~= nil
end
local function bridge_input(input, token_required)
  return type(input) == 'table' and bridge_digest(input.slotId) and bridge_id(input.workspaceId) and bridge_id(input.projectId) and bridge_id(input.agentId) and bridge_profile(input) and (not token_required or bridge_token(input.ownerToken))
end
local function bridge_key_types(keys, with_session)
  local expected = {'hash', 'string', 'set', 'zset', 'stream', 'stream'}
  if with_session then expected[7] = 'hash' end
  if #keys ~= #expected then return false end
  for i, wanted in ipairs(expected) do
    if not type_is(keys[i], wanted) then return false end
    for j = 1, i - 1 do if keys[i] == keys[j] then return false end end
  end
  return true
end
local function key_namespace(global_event_key)
  local suffix = ':events:global'
  if type(global_event_key) ~= 'string' or #global_event_key <= #suffix or string.sub(global_event_key, -#suffix) ~= suffix then return nil end
  return string.sub(global_event_key, 1, #global_event_key - #suffix)
end
local function exact_key(prefix, key, suffix) return key == prefix .. suffix end
local function bridge_keys_at_prefix(keys, offset, prefix, identity)
  return exact_key(prefix, keys[offset + 1], ':bridge-slot:' .. identity.slotId)
    and exact_key(prefix, keys[offset + 2], ':bridge-slot-owner:' .. identity.slotId)
    and exact_key(prefix, keys[offset + 3], ':index:bridge-slots')
    and exact_key(prefix, keys[offset + 4], ':deadline:bridge-slots')
end
local function bridge_keys_match(keys, identity, with_session)
  local prefix = key_namespace(keys[5])
  return prefix ~= nil
    and bridge_keys_at_prefix(keys, 0, prefix, identity)
    and exact_key(prefix, keys[6], ':events:project:' .. identity.projectId)
    and (not with_session or exact_key(prefix, keys[7], ':session:' .. identity.sessionId))
end
local function session_keys_match(keys, session, native, declared, bridge, bridge_offset)
  local prefix = key_namespace(keys[7])
  if not prefix
    or not exact_key(prefix, keys[1], ':session:' .. session.id)
    or not exact_key(prefix, keys[2], ':project:' .. session.projectId)
    or not exact_key(prefix, keys[3], ':index:project:' .. session.projectId .. ':sessions')
    or not exact_key(prefix, keys[4], ':index:agent:' .. session.agentId .. ':sessions')
    or not exact_key(prefix, keys[5], ':presence:session:' .. session.id)
    or not exact_key(prefix, keys[6], ':deadline:heartbeats')
    or not exact_key(prefix, keys[8], ':events:project:' .. session.projectId)
    or not exact_key(prefix, keys[9], ':inbox:session:' .. session.id)
  then return false end
  if native then
    if type(declared.bindingId) ~= 'string' or type(declared.linkId) ~= 'string'
      or not exact_key(prefix, keys[10], ':native-session:' .. declared.bindingId)
      or not exact_key(prefix, keys[11], ':native-session-link:' .. declared.linkId)
      or not exact_key(prefix, keys[12], ':index:native-session:' .. declared.bindingId .. ':links')
      or not exact_key(prefix, keys[13], ':index:session:' .. session.id .. ':native')
    then return false end
    if declared.staleLinkId then
      if type(declared.staleLinkId) ~= 'string' or not exact_key(prefix, keys[14], ':native-session-link:' .. declared.staleLinkId) then return false end
    elseif keys[14] ~= keys[10] then return false end
  end
  return not bridge or bridge_keys_at_prefix(keys, bridge_offset, prefix, bridge)
end
local function bridge_read(slot_key, owner_key, index_key, deadline_key, identity)
  local exists = key_type(slot_key) ~= 'none'
  local token = redis.call('GET', owner_key)
  local ttl = redis.call('PTTL', owner_key)
  local score = redis.call('ZSCORE', deadline_key, identity.slotId)
  local indexed = redis.call('SISMEMBER', index_key, identity.slotId)
  if not exists then
    if token or score or indexed ~= 0 then return nil, nil, 'REDIS_STATE_INVALID' end
    return nil, nil, nil
  end
  if redis.call('PTTL', slot_key) ~= -1 then return nil, nil, 'REDIS_STATE_INVALID' end
  local encoded = redis.call('HGET', slot_key, 'json')
  if not encoded then return nil, nil, 'REDIS_STATE_INVALID' end
  local valid, slot = pcall(cjson.decode, encoded)
  if not valid or type(slot) ~= 'table' then return nil, nil, 'REDIS_STATE_INVALID' end
  local fields = {id=true, workspaceId=true, projectId=true, agentId=true, provider=true, executionProfile=true, state=true, revision=true, sessionId=true, expiresAt=true}
  for field, _ in pairs(slot) do if not fields[field] then return nil, nil, 'REDIS_STATE_INVALID' end end
  if slot.id ~= identity.slotId or slot.workspaceId ~= identity.workspaceId or slot.projectId ~= identity.projectId or slot.agentId ~= identity.agentId or not bridge_profile(slot) or not bridge_integer(slot.revision, 1) or type(slot.expiresAt) ~= 'string' or not string.match(slot.expiresAt, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d%.%d%d%dZ$') or (slot.sessionId ~= nil and not bridge_id(slot.sessionId)) or indexed ~= 1 then
    return nil, nil, 'REDIS_STATE_INVALID'
  end
  if slot.state == 'active' then
    local deadline = tonumber(score)
    if not bridge_integer(deadline, 0) or iso_from_milliseconds(deadline) ~= slot.expiresAt then return nil, nil, 'REDIS_STATE_INVALID' end
    if token and (not bridge_token(token) or ttl <= 0 or ttl > BRIDGE_TTL or redis.call('PEXPIRETIME', owner_key) ~= deadline) then return nil, nil, 'REDIS_STATE_INVALID' end
  elseif slot.state == 'standby' or slot.state == 'expired' or slot.state == 'degraded' then
    if token or score or slot.sessionId then return nil, nil, 'REDIS_STATE_INVALID' end
  else return nil, nil, 'REDIS_STATE_INVALID' end
  return slot, token, nil
end
local function bridge_owned(slot, token, input, now)
  return slot ~= nil and slot.state == 'active' and token == input.ownerToken and slot.provider == input.provider and slot.executionProfile == input.executionProfile and slot.expiresAt > now.timestamp
end
local function bridge_write(key, slot) redis.call('HSET', key, 'json', cjson.encode(slot)) end
local function bridge_event(global_key, project_key, slot, event_id, kind, clock)
  local event = {id=event_id, version=1, type='bridge.slot.' .. kind, occurredAt=clock.timestamp, workspaceId=slot.workspaceId, projectId=slot.projectId, agentId=slot.agentId, payload={slot=slot}}
  if slot.sessionId then event.sessionId = slot.sessionId end
  local streams = append_event(global_key, project_key, cjson.encode(event))
  return {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId}
end
local function bridge_attach_apply(slot_key, slot, session_id, global_key, project_key, event_id, clock)
  slot.sessionId = session_id
  slot.revision = slot.revision + 1
  bridge_write(slot_key, slot)
  return bridge_event(global_key, project_key, slot, event_id, 'attached', clock)
end
local function bridge_transition(keys, args, operation)
  local with_session = operation == 'attach'
  if #args ~= 1 then return bridge_error('REDIS_ARGUMENT_INVALID') end
  local decoded, input = pcall(cjson.decode, args[1])
  if not decoded or not bridge_input(input, operation ~= 'expire') or not bridge_id(input.eventId) then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if input.ownerToken and input.eventId == input.ownerToken then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if (operation == 'acquire' or operation == 'renew') and input.ttlMs ~= BRIDGE_TTL then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if operation == 'acquire' and (not bridge_id(input.expiredEventId) or input.eventId == input.expiredEventId or input.expiredEventId == input.ownerToken) then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if with_session and not bridge_id(input.sessionId) then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if operation == 'expire' and (not bridge_integer(input.expectedRevision, 1) or type(input.expectedExpiresAt) ~= 'string') then return bridge_error('REDIS_ARGUMENT_INVALID') end
  if not bridge_key_types(keys, with_session) or not bridge_keys_match(keys, input, with_session) then return bridge_error('REDIS_STATE_INVALID') end
  local slot, token, invalid = bridge_read(keys[1], keys[2], keys[3], keys[4], input)
  if invalid then return bridge_error(invalid) end
  local clock = redis_now()
  if operation == 'acquire' and token then
    if bridge_owned(slot, token, input, clock) then return cjson.encode({status='acquired', slot=slot}) end
    return cjson.encode({status='held', slot=slot})
  end
  if operation == 'expire' then
    if not slot or slot.state ~= 'active' or token or slot.provider ~= input.provider or slot.executionProfile ~= input.executionProfile or slot.revision ~= input.expectedRevision or slot.expiresAt ~= input.expectedExpiresAt or slot.expiresAt > clock.timestamp then
      return cjson.encode({status='unchanged', slot=slot})
    end
  elseif operation ~= 'acquire' and not bridge_owned(slot, token, input, clock) then
    return cjson.encode({status='not_owner'})
  end
  if with_session then
    local session = redis.call('HMGET', keys[7], 'id', 'projectId', 'agentId', 'status')
    if session[1] ~= input.sessionId or session[2] ~= input.projectId or session[3] ~= input.agentId or not session[4] or session[4] == 'completed' or session[4] == 'disconnected' then return bridge_error('REDIS_STATE_INVALID') end
    if slot.sessionId == input.sessionId then return cjson.encode({status='unchanged', slot=slot}) end
  end
  local needed = 1
  if operation == 'acquire' and slot and slot.state == 'active' then needed = 2 end
  if operation == 'renew' then needed = 0 end
  if slot and slot.revision > MAX_SAFE_INTEGER - math.max(needed, 1) then return bridge_error('REDIS_STATE_INVALID') end
  if needed > 0 and (not stream_has_capacity(keys[5], needed) or not stream_has_capacity(keys[6], needed)) then return bridge_error('REDIS_STATE_INVALID') end
  -- All key, record, owner, revision and append checks precede this boundary.
  if operation == 'acquire' then
    local revision = 0
    if slot then revision = slot.revision end
    if slot and slot.state == 'active' then
      slot.state = 'expired'; slot.sessionId = nil; slot.revision = slot.revision + 1
      bridge_event(keys[5], keys[6], slot, input.expiredEventId, 'expired', clock)
      revision = slot.revision
    end
    slot = {id=input.slotId, workspaceId=input.workspaceId, projectId=input.projectId, agentId=input.agentId, provider=input.provider, executionProfile=input.executionProfile, state='active', revision=revision + 1, expiresAt=iso_from_milliseconds(clock.milliseconds + BRIDGE_TTL)}
    redis.call('SET', keys[2], input.ownerToken, 'PX', BRIDGE_TTL)
    redis.call('SADD', keys[3], slot.id)
    redis.call('ZADD', keys[4], clock.milliseconds + BRIDGE_TTL, slot.id)
    bridge_write(keys[1], slot)
    bridge_event(keys[5], keys[6], slot, input.eventId, 'acquired', clock)
    return cjson.encode({status='acquired', slot=slot})
  elseif operation == 'renew' then
    slot.expiresAt = iso_from_milliseconds(clock.milliseconds + BRIDGE_TTL)
    redis.call('PEXPIRE', keys[2], BRIDGE_TTL)
    redis.call('ZADD', keys[4], clock.milliseconds + BRIDGE_TTL, slot.id)
    bridge_write(keys[1], slot)
    return cjson.encode({status='renewed', slot=slot})
  elseif operation == 'attach' then
    bridge_attach_apply(keys[1], slot, input.sessionId, keys[5], keys[6], input.eventId, clock)
    return cjson.encode({status='attached', slot=slot})
  else
    slot.state = 'expired'
    local status = 'expired'
    if operation == 'release' then slot.state = 'standby'; status = 'released' end
    slot.sessionId = nil; slot.revision = slot.revision + 1
    redis.call('DEL', keys[2]); redis.call('ZREM', keys[4], slot.id)
    bridge_write(keys[1], slot)
    bridge_event(keys[5], keys[6], slot, input.eventId, status, clock)
    return cjson.encode({status=status, slot=slot})
  end
end
local function bridge_slot_acquire(keys, args) return bridge_transition(keys, args, 'acquire') end
local function bridge_slot_renew(keys, args) return bridge_transition(keys, args, 'renew') end
local function bridge_slot_attach(keys, args) return bridge_transition(keys, args, 'attach') end
local function bridge_slot_release(keys, args) return bridge_transition(keys, args, 'release') end
local function bridge_slot_expire(keys, args) return bridge_transition(keys, args, 'expire') end`,
    'local function project_register(keys, args)',
    '  if #keys ~= 5 or #args ~= 3 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local decoded, project = pcall(cjson.decode, args[1])',
    "  if not decoded or type(project) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local required = {'id', 'name', 'localPath', 'canonicalPath', 'identityPath', 'pathIdentityHash'}",
    '  for _, field in ipairs(required) do',
    "    if type(project[field]) ~= 'string' or project[field] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '  end',
    "  if type(project.createdAt) == 'string' and type(project.updatedAt) == 'string' then",
    "    if project.createdAt == '' or project.updatedAt == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '  elseif project.createdAt ~= nil or project.updatedAt ~= nil then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(args[2]) ~= 'string' or args[2] == '' or type(args[3]) ~= 'string' or args[3] == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'set') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) ~= 'none' then",
    "    return cjson.encode({status='error', code='PROJECT_ID_CONFLICT'})",
    '  end',
    "  local existing_identity = redis.call('GET', keys[2])",
    '  if existing_identity then',
    '    local valid, existing = pcall(cjson.decode, existing_identity)',
    "    if not valid or type(existing) ~= 'table' or type(existing.projectId) ~= 'string' or type(existing.identityPath) ~= 'string' or type(existing.canonicalPath) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    if existing.identityPath == project.identityPath then',
    "      return cjson.encode({status='conflict', reason='duplicate', existingProjectId=existing.projectId, canonicalPath=existing.canonicalPath})",
    '    end',
    "    return cjson.encode({status='conflict', reason='hash_collision'})",
    '  end',
    '  if not stream_appendable(keys[4]) or not stream_appendable(keys[5]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local timestamp = redis_now().timestamp',
    '  local stored = {',
    '    id=project.id, name=project.name, localPath=project.localPath,',
    '    canonicalPath=project.canonicalPath, createdAt=timestamp, updatedAt=timestamp',
    '  }',
    "  if type(project.createdAt) == 'string' and type(project.updatedAt) == 'string' then",
    '    stored.createdAt = project.createdAt',
    '    stored.updatedAt = project.updatedAt',
    '  end',
    "  if type(project.repositoryUrl) == 'string' then stored.repositoryUrl = project.repositoryUrl end",
    "  if type(project.defaultBranch) == 'string' then stored.defaultBranch = project.defaultBranch end",
    '  local event = {',
    "    id=args[3], version=1, type='project.registered', occurredAt=timestamp,",
    '    workspaceId=args[2], projectId=project.id, payload={project=stored}',
    '  }',
    '  local event_json = cjson.encode(event)',
    "  redis.call('HSET', keys[1], 'id', stored.id, 'name', stored.name, 'localPath', stored.localPath, 'canonicalPath', stored.canonicalPath, 'identityPath', project.identityPath, 'pathIdentityHash', project.pathIdentityHash, 'createdAt', stored.createdAt, 'updatedAt', stored.updatedAt)",
    "  if stored.repositoryUrl then redis.call('HSET', keys[1], 'repositoryUrl', stored.repositoryUrl) end",
    "  if stored.defaultBranch then redis.call('HSET', keys[1], 'defaultBranch', stored.defaultBranch) end",
    "  redis.call('SET', keys[2], cjson.encode({projectId=project.id, identityPath=project.identityPath, canonicalPath=project.canonicalPath}))",
    "  redis.call('SADD', keys[3], project.id)",
    '  local streams = append_event(keys[4], keys[5], event_json)',
    "  return cjson.encode({status='created', project=stored, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function session_register(keys, args)',
    '  if (#keys ~= 9 and #keys ~= 14 and #keys ~= 13 and #keys ~= 18) or #args < 5 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local decoded, session = pcall(cjson.decode, args[1])',
    "  if not decoded or type(session) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local required = {'id', 'agentId', 'projectId', 'status', 'workingDirectory', 'metadataJson'}",
    '  for _, field in ipairs(required) do',
    "    if type(session[field]) ~= 'string' or session[field] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '  end',
    "  if session.status ~= 'starting' or type(args[2]) ~= 'string' or args[2] == '' or type(args[3]) ~= 'string' or args[3] == '' or type(args[5]) ~= 'string' or args[5] == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local ttl = tonumber(args[4])',
    '  if not ttl or ttl < 1 or ttl > 2147483647 or ttl ~= math.floor(ttl) then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local metadata_valid, metadata = pcall(cjson.decode, session.metadataJson)',
    "  if not metadata_valid or type(metadata) ~= 'table' or not string.match(session.metadataJson, '^%s*{') or #session.metadataJson > 16384 then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if bridge_reserved(metadata) then return cjson.encode({status='reserved_metadata_rejected'}) end",
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'set') or not type_is(keys[4], 'set') or not type_is(keys[5], 'string') or not type_is(keys[6], 'zset') or not type_is(keys[7], 'stream') or not type_is(keys[8], 'stream') or not type_is(keys[9], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    `  -- A committed registration owns its retry result. Its external slot,
  -- project and native-link dependencies may legitimately change afterwards.
  if key_type(keys[1]) ~= 'none' then
    if redis.call('HGET', keys[1], 'registrationEventId') == args[3] and redis.call('HGET', keys[1], 'id') == session.id and redis.call('HGET', keys[1], 'agentId') == session.agentId and redis.call('HGET', keys[1], 'projectId') == session.projectId then
      local result = redis.call('HGET', keys[1], 'registrationResult')
      if result then return result end
    end
    return bridge_error('SESSION_ID_CONFLICT')
  end`,
    "  if not session_keys_match(keys, session, nil, nil, nil, nil) then return bridge_error('REDIS_STATE_INVALID') end",
    "  if key_type(keys[2]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='project'})",
    '  end',
    "  local stored_project_id = redis.call('HGET', keys[2], 'id')",
    '  if stored_project_id ~= session.projectId then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    `  local bridge = nil
  local bridge_slot = nil
  local bridge_offset = nil
  local clock = redis_now()
  if #keys == 13 or #keys == 18 then
    bridge_offset = #keys - 4
    local valid_bridge, declaration = pcall(cjson.decode, args[10] or '')
    if not valid_bridge or type(declaration) ~= 'table' or not bridge_id(args[11]) or args[11] == args[3] then return bridge_error('REDIS_ARGUMENT_INVALID') end
    for field, _ in pairs(declaration) do
      if field ~= 'slotId' and field ~= 'ownerToken' and field ~= 'provider' and field ~= 'executionProfile' then return bridge_error('REDIS_ARGUMENT_INVALID') end
    end
    declaration.workspaceId = args[2]; declaration.projectId = session.projectId; declaration.agentId = session.agentId
    if not bridge_input(declaration, true) then return bridge_error('REDIS_ARGUMENT_INVALID') end
    local expected = {'hash', 'string', 'set', 'zset'}
    for i, wanted in ipairs(expected) do
      local key = keys[bridge_offset + i]
      if not type_is(key, wanted) then return bridge_error('REDIS_STATE_INVALID') end
      for j = 1, bridge_offset + i - 1 do if key == keys[j] then return bridge_error('REDIS_STATE_INVALID') end end
    end
    if keys[7] == keys[8] then return bridge_error('REDIS_STATE_INVALID') end
    local token, invalid
    bridge_slot, token, invalid = bridge_read(keys[bridge_offset + 1], keys[bridge_offset + 2], keys[bridge_offset + 3], keys[bridge_offset + 4], declaration)
    if invalid then return bridge_error(invalid) end
    if not bridge_owned(bridge_slot, token, declaration, clock) then return cjson.encode({status='bridge_slot_not_owner'}) end
    bridge = declaration
    metadata.bridge = 'native-headless'; metadata.bridgeSlotId = bridge.slotId
    metadata.provider = bridge.provider; metadata.executionProfile = bridge.executionProfile
    session.metadataJson = cjson.encode(metadata)
  end
  if #session.metadataJson > 16384 then return bridge_error('REDIS_ARGUMENT_INVALID') end`,
    '  local native = nil',
    '  local declared = nil',
    '  local event_count = 1',
    '  if #keys == 14 or #keys == 18 then',
    "    if type(args[6]) ~= 'string' or type(args[7]) ~= 'string' or type(args[8]) ~= 'string' or args[8] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    local native_ok, decoded_native = pcall(cjson.decode, args[6])',
    "    if not native_ok or type(decoded_native) ~= 'table' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    local declared_ok, decoded_declared = pcall(cjson.decode, args[7])',
    "    if not declared_ok or type(decoded_declared) ~= 'table' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    native = decoded_native',
    '    declared = decoded_declared',
    '    event_count = 2',
    '    if native.staleLinkId then',
    "      if type(args[9]) ~= 'string' or args[9] == '' then",
    "        return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '      end',
    '      event_count = 3',
    '    end',
    "    if not type_is(keys[10], 'hash') or not type_is(keys[11], 'hash') or not type_is(keys[12], 'zset') or not type_is(keys[13], 'string') or not type_is(keys[14], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '  end',
    `  if bridge then
    if bridge_slot.revision >= MAX_SAFE_INTEGER then return bridge_error('REDIS_STATE_INVALID') end
    if bridge.ownerToken == args[3] or bridge.ownerToken == args[8] or bridge.ownerToken == args[9] or bridge.ownerToken == args[11] or args[11] == args[8] or args[11] == args[9] then return bridge_error('REDIS_ARGUMENT_INVALID') end
    event_count = event_count + 1
  end`,
    "  if not session_keys_match(keys, session, native, declared, bridge, bridge_offset) then return bridge_error('REDIS_STATE_INVALID') end",
    '  if not stream_has_capacity(keys[7], event_count) or not stream_has_capacity(keys[8], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  -- Validation runs before XGROUP CREATE, which creates a stream: a conflict',
    '  -- discovered afterwards would leave an inbox stream for a session that was',
    '  -- never registered.',
    '  if native then',
    '    local native_error = native_validate(keys[10], keys[11], keys[14], native, session.id, declared)',
    '    if native_error then',
    "      return cjson.encode({status='error', code=native_error})",
    '    end',
    '  end',
    '  local stored = {',
    "    id=session.id, agentId=session.agentId, projectId=session.projectId, status='starting',",
    '    workingDirectory=session.workingDirectory, startedAt=clock.timestamp,',
    '    lastHeartbeatAt=clock.timestamp, metadata=metadata',
    '  }',
    "  if type(session.taskSummary) == 'string' then stored.taskSummary = session.taskSummary end",
    "  if type(session.branch) == 'string' then stored.branch = session.branch end",
    "  if type(session.worktreePath) == 'string' then stored.worktreePath = session.worktreePath end",
    '  local event = {',
    "    id=args[3], version=1, type='session.registered', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=session.projectId, agentId=session.agentId,',
    '    sessionId=session.id, payload={session=stored}',
    '  }',
    '  local event_json = cjson.encode(event)',
    "  local group_ok, group_result = pcall(redis.call, 'XGROUP', 'CREATE', keys[9], args[5], '0-0', 'MKSTREAM')",
    "  if not group_ok and not string.find(tostring(group_result), 'BUSYGROUP') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', stored.id, 'agentId', stored.agentId, 'projectId', stored.projectId, 'status', stored.status, 'workingDirectory', stored.workingDirectory, 'startedAt', stored.startedAt, 'lastHeartbeatAt', stored.lastHeartbeatAt, 'metadata', session.metadataJson)",
    "  if stored.taskSummary then redis.call('HSET', keys[1], 'taskSummary', stored.taskSummary) end",
    "  if stored.branch then redis.call('HSET', keys[1], 'branch', stored.branch) end",
    "  if stored.worktreePath then redis.call('HSET', keys[1], 'worktreePath', stored.worktreePath) end",
    "  redis.call('SADD', keys[3], session.id)",
    "  redis.call('SADD', keys[4], session.id)",
    "  redis.call('SET', keys[5], session.id, 'PX', ttl)",
    "  redis.call('ZADD', keys[6], clock.milliseconds + ttl, session.id)",
    '  local unlinked_event = nil',
    '  if native then',
    '    unlinked_event = native_apply(keys[10], keys[11], keys[12], keys[13], keys[14], native, clock, args[9], args[2])',
    '  end',
    '  local streams = append_event(keys[7], keys[8], event_json)',
    `  local attached_event = nil
  if bridge then attached_event = bridge_attach_apply(keys[bridge_offset + 1], bridge_slot, session.id, keys[7], keys[8], args[11], clock) end
  local function remember(result)
    local encoded = cjson.encode(result)
    redis.call('HSET', keys[1], 'registrationEventId', args[3], 'registrationResult', encoded)
    return encoded
  end`,
    `  if not native then
    local result = {status='created', session=stored, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId}
    if attached_event then result.events = {{event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId}, attached_event} end
    return remember(result)`,
    '  end',
    '  local events = {{event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId}}',
    '  if attached_event then events[#events + 1] = attached_event end',
    '  if unlinked_event then',
    '    local unlinked_streams = append_event(keys[7], keys[8], cjson.encode(unlinked_event))',
    '    events[#events + 1] = {event=unlinked_event, globalStreamId=unlinked_streams.globalStreamId, projectStreamId=unlinked_streams.projectStreamId}',
    '  end',
    '  local linked_event = {',
    "    id=args[8], version=1, type='session.native.linked', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=session.projectId, agentId=session.agentId,',
    '    sessionId=session.id,',
    '    payload={bindingId=native.bindingId, linkId=native.link.id}',
    '  }',
    '  local linked_streams = append_event(keys[7], keys[8], cjson.encode(linked_event))',
    '  events[#events + 1] = {event=linked_event, globalStreamId=linked_streams.globalStreamId, projectStreamId=linked_streams.projectStreamId}',
    "  local transition = 'linked'",
    "  if tonumber(native.expectedVersion) == 0 then transition = 'created' end",
    "  local native_result = {transition=transition, binding=redis.call('HGETALL', keys[10]), link=redis.call('HGETALL', keys[11])}",
    "  if native.staleLinkId then native_result.staleLink = redis.call('HGETALL', keys[14]) end",
    "  return remember({status='created', session=stored, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, native=native_result, events=events})",
    'end',
    '-- B0: an already-registered, live session declaring its native identity.',
    '-- The policy has already decided in @luwi/runtime; this validates that the',
    '-- observation still holds — the session live, the CAS on the binding',
    '-- version — and applies it. Unlike session_register there is no XGROUP',
    '-- CREATE to order against: the session and its inbox already exist, so',
    '-- this is a straight validate-then-apply, and a refusal writes nothing.',
    'local function native_declare(keys, args)',
    '  if #keys ~= 8 or #args < 4 or #args > 5 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local native_ok, native = pcall(cjson.decode, args[1])',
    "  if not native_ok or type(native) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local declared_ok, declared = pcall(cjson.decode, args[2])',
    "  if not declared_ok or type(declared) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(declared.sessionId) ~= 'string' or declared.sessionId == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(declared.projectId) ~= 'string' or declared.projectId == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(args[3]) ~= 'string' or args[3] == '' or type(args[4]) ~= 'string' or args[4] == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local event_count = 1',
    '  if native.staleLinkId then',
    "    if type(args[5]) ~= 'string' or args[5] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    event_count = 2',
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'hash') or not type_is(keys[4], 'zset') or not type_is(keys[5], 'string') or not type_is(keys[6], 'hash') or not type_is(keys[7], 'stream') or not type_is(keys[8], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='session'})",
    '  end',
    '  -- The session key must hold the session the caller declared for, in the',
    '  -- project whose stream was declared. A mismatch is a caller defect, not',
    '  -- contention, so it refuses rather than retries.',
    "  local values = redis.call('HMGET', keys[1], 'id', 'agentId', 'projectId', 'status')",
    '  if values[1] ~= declared.sessionId or not values[2] or not values[4] then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  if values[3] ~= declared.projectId then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  -- A terminal session cannot declare: its interval is already closed, and',
    '  -- a fresh open link would claim evidence the session can no longer earn.',
    "  if values[4] == 'completed' or values[4] == 'disconnected' then",
    "    return cjson.encode({status='terminal', currentStatus=values[4]})",
    '  end',
    '  if not stream_has_capacity(keys[7], event_count) or not stream_has_capacity(keys[8], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local native_error = native_validate(keys[2], keys[3], keys[6], native, declared.sessionId, declared)',
    '  if native_error then',
    "    return cjson.encode({status='error', code=native_error})",
    '  end',
    '  local clock = redis_now()',
    '  local unlinked_event = native_apply(keys[2], keys[3], keys[4], keys[5], keys[6], native, clock, args[5], args[3])',
    '  local events = {}',
    '  if unlinked_event then',
    '    local unlinked_streams = append_event(keys[7], keys[8], cjson.encode(unlinked_event))',
    '    events[#events + 1] = {event=unlinked_event, globalStreamId=unlinked_streams.globalStreamId, projectStreamId=unlinked_streams.projectStreamId}',
    '  end',
    '  local linked_event = {',
    "    id=args[4], version=1, type='session.native.linked', occurredAt=clock.timestamp,",
    '    workspaceId=args[3], projectId=values[3], agentId=values[2], sessionId=values[1],',
    '    payload={bindingId=native.bindingId, linkId=native.link.id}',
    '  }',
    '  local linked_streams = append_event(keys[7], keys[8], cjson.encode(linked_event))',
    '  events[#events + 1] = {event=linked_event, globalStreamId=linked_streams.globalStreamId, projectStreamId=linked_streams.projectStreamId}',
    "  local transition = 'linked'",
    "  if tonumber(native.expectedVersion) == 0 then transition = 'created' end",
    "  local native_result = {transition=transition, binding=redis.call('HGETALL', keys[2]), link=redis.call('HGETALL', keys[3])}",
    "  if native.staleLinkId then native_result.staleLink = redis.call('HGETALL', keys[6]) end",
    "  return cjson.encode({status='declared', native=native_result, events=events})",
    'end',
    'local function session_status(keys, args)',
    '  if (#keys ~= 5 and #keys ~= 7) or #args < 4 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'zset') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='session'})",
    '  end',
    '  local target = args[1]',
    '  local allowed = {idle=true, thinking=true, tool_running=true, waiting_for_input=true, waiting_for_agent=true, blocked=true, completed=true}',
    '  if not allowed[target] or args[2] == "" or args[3] == "" or args[4] == "" then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local values = redis.call('HMGET', keys[1], 'id', 'agentId', 'projectId', 'status')",
    '  if not values[1] or not values[2] or not values[3] or not values[4] or values[3] ~= args[2] then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local current = values[4]',
    '  if current == target then',
    "    return cjson.encode({status='unchanged', currentStatus=current})",
    '  end',
    "  if current == 'completed' or current == 'disconnected' then",
    "    return cjson.encode({status='terminal', currentStatus=current})",
    '  end',
    '  local native = nil',
    '  local event_count = 1',
    '  -- Only `completed` is terminal. A session completed through the status',
    '  -- endpoint must not leave openLinkId behind.',
    "  if #keys == 7 and target == 'completed' then",
    '    local native_ok, decoded_native = pcall(cjson.decode, args[5])',
    "    if not native_ok or type(decoded_native) ~= 'table' or type(args[6]) ~= 'string' or args[6] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded_native',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local clock = redis_now()',
    '  local native_event = nil',
    '  if native then',
    '    local produced, native_error = native_unlink(keys[6], keys[7], native, values[1], clock, args[6], args[2])',
    "    if native_error then return cjson.encode({status='error', code=native_error}) end",
    '    native_event = produced',
    '  end',
    "  redis.call('HSET', keys[1], 'status', target)",
    "  if target == 'completed' then",
    "    redis.call('DEL', keys[2])",
    "    redis.call('ZREM', keys[3], values[1])",
    '  end',
    '  local event = {',
    "    id=args[4], version=1, type='session.status.changed', occurredAt=clock.timestamp,",
    '    workspaceId=args[3], projectId=values[3], agentId=values[2], sessionId=values[1],',
    '    payload={previousStatus=current, currentStatus=target}',
    '  }',
    '  local event_json = cjson.encode(event)',
    '  local streams = append_event(keys[4], keys[5], event_json)',
    '  if not native_event then',
    "    return cjson.encode({status='updated', previousStatus=current, currentStatus=target, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local native_streams = append_event(keys[4], keys[5], cjson.encode(native_event))',
    '  local events = {',
    '    {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId},',
    '    {event=native_event, globalStreamId=native_streams.globalStreamId, projectStreamId=native_streams.projectStreamId}',
    '  }',
    "  return cjson.encode({status='updated', previousStatus=current, currentStatus=target, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, events=events})",
    'end',
    'local function session_heartbeat(keys, args)',
    '  if #keys ~= 5 or #args ~= 7 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'zset') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='session'})",
    '  end',
    '  local ttl = tonumber(args[4])',
    '  local interval = tonumber(args[5])',
    "  if args[1] == '' or args[2] == '' or args[3] == '' or not ttl or ttl < 1 or ttl > 2147483647 or ttl ~= math.floor(ttl) or not interval or interval < 0 or interval > MAX_SAFE_INTEGER or interval ~= math.floor(interval) or (args[6] ~= '0' and args[6] ~= '1') then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local values = redis.call('HMGET', keys[1], 'id', 'agentId', 'projectId', 'status', 'metadata', 'lastHeartbeatEventAt')",
    '  if not values[1] or not values[2] or not values[3] or not values[4] or not values[5] or values[3] ~= args[1] then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if values[4] == 'completed' or values[4] == 'disconnected' then",
    "    return cjson.encode({status='terminal', currentStatus=values[4]})",
    '  end',
    '  local metadata_changed = false',
    '  local next_metadata = args[7]',
    "  if args[6] == '1' then",
    '    local valid_metadata, decoded_metadata = pcall(cjson.decode, args[7])',
    "    if not valid_metadata or type(decoded_metadata) ~= 'table' or not string.match(args[7], '^%s*{') or #args[7] > 16384 then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    `    if bridge_reserved(decoded_metadata) then return cjson.encode({status='reserved_metadata_rejected'}) end
    local stored_valid, stored_metadata = pcall(cjson.decode, values[5])
    if not stored_valid or type(stored_metadata) ~= 'table' then return bridge_error('REDIS_STATE_INVALID') end
    if bridge_reserved(stored_metadata) then
      if stored_metadata.bridge ~= 'native-headless' or not bridge_digest(stored_metadata.bridgeSlotId) or not bridge_profile(stored_metadata) then return bridge_error('REDIS_STATE_INVALID') end
      decoded_metadata.bridge = stored_metadata.bridge; decoded_metadata.bridgeSlotId = stored_metadata.bridgeSlotId
      decoded_metadata.provider = stored_metadata.provider; decoded_metadata.executionProfile = stored_metadata.executionProfile
      next_metadata = cjson.encode(decoded_metadata)
    end
    if #next_metadata > 16384 then return bridge_error('REDIS_ARGUMENT_INVALID') end
    metadata_changed = values[5] ~= next_metadata`,
    '  end',
    '  local clock = redis_now()',
    '  local last_event_ms = tonumber(values[6])',
    '  local emit_event = not last_event_ms or (clock.milliseconds - last_event_ms) >= interval or metadata_changed',
    '  if emit_event and (not stream_appendable(keys[4]) or not stream_appendable(keys[5])) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'lastHeartbeatAt', clock.timestamp)",
    "  if args[6] == '1' then redis.call('HSET', keys[1], 'metadata', next_metadata) end",
    "  redis.call('SET', keys[2], values[1], 'PX', ttl)",
    "  redis.call('ZADD', keys[3], clock.milliseconds + ttl, values[1])",
    '  if not emit_event then',
    "    return cjson.encode({status='renewed', eventEmitted=false, lastHeartbeatAt=clock.timestamp})",
    '  end',
    "  redis.call('HSET', keys[1], 'lastHeartbeatEventAt', clock.milliseconds)",
    '  local event = {',
    "    id=args[3], version=1, type='session.heartbeat', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=values[3], agentId=values[2], sessionId=values[1],',
    '    payload={metadataChanged=metadata_changed}',
    '  }',
    '  local event_json = cjson.encode(event)',
    '  local streams = append_event(keys[4], keys[5], event_json)',
    "  return cjson.encode({status='renewed', eventEmitted=true, lastHeartbeatAt=clock.timestamp, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function session_close(keys, args)',
    '  if (#keys ~= 5 and #keys ~= 7) or #args < 3 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'zset') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='session'})",
    '  end',
    "  if args[1] == '' or args[2] == '' or args[3] == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local values = redis.call('HMGET', keys[1], 'id', 'agentId', 'projectId', 'status')",
    '  if not values[1] or not values[2] or not values[3] or not values[4] or values[3] ~= args[1] then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if values[4] == 'completed' then",
    "    return cjson.encode({status='unchanged', currentStatus='completed'})",
    '  end',
    "  if values[4] == 'disconnected' then",
    "    return cjson.encode({status='terminal', currentStatus='disconnected'})",
    '  end',
    '  local native = nil',
    '  local event_count = 1',
    '  if #keys == 7 then',
    '    local native_ok, decoded_native = pcall(cjson.decode, args[4])',
    "    if not native_ok or type(decoded_native) ~= 'table' or type(args[5]) ~= 'string' or args[5] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded_native',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local clock = redis_now()',
    '  local native_event = nil',
    '  if native then',
    '    local produced, native_error = native_unlink(keys[6], keys[7], native, values[1], clock, args[5], args[2])',
    "    if native_error then return cjson.encode({status='error', code=native_error}) end",
    '    native_event = produced',
    '  end',
    "  redis.call('HSET', keys[1], 'status', 'completed')",
    "  redis.call('DEL', keys[2])",
    "  redis.call('ZREM', keys[3], values[1])",
    '  local event = {',
    "    id=args[3], version=1, type='session.completed', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=values[3], agentId=values[2], sessionId=values[1],',
    "    payload={previousStatus=values[4], currentStatus='completed'}",
    '  }',
    '  local event_json = cjson.encode(event)',
    '  local streams = append_event(keys[4], keys[5], event_json)',
    '  if not native_event then',
    "    return cjson.encode({status='completed', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local native_streams = append_event(keys[4], keys[5], cjson.encode(native_event))',
    '  local events = {',
    '    {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId},',
    '    {event=native_event, globalStreamId=native_streams.globalStreamId, projectStreamId=native_streams.projectStreamId}',
    '  }',
    "  return cjson.encode({status='completed', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, events=events})",
    'end',
    'local function session_disconnect(keys, args)',
    '  if (#keys ~= 5 and #keys ~= 7) or #args < 4 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'zset') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='not_found', entity='session'})",
    '  end',
    '  local expected_deadline = tonumber(args[4])',
    "  if args[1] == '' or args[2] == '' or args[3] == '' or not expected_deadline then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local values = redis.call('HMGET', keys[1], 'id', 'agentId', 'projectId', 'status')",
    '  if not values[1] or not values[2] or not values[3] or not values[4] or values[3] ~= args[1] then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  local current_deadline = redis.call('ZSCORE', keys[3], values[1])",
    '  if not current_deadline or tonumber(current_deadline) ~= expected_deadline then',
    "    return cjson.encode({status='unchanged'})",
    '  end',
    "  if values[4] == 'completed' or values[4] == 'disconnected' then",
    "    redis.call('ZREM', keys[3], values[1])",
    "    return cjson.encode({status='unchanged'})",
    '  end',
    "  local presence_ttl = redis.call('PTTL', keys[2])",
    '  if presence_ttl > 0 then',
    '    local clock = redis_now()',
    '    local reconciled_deadline = clock.milliseconds + presence_ttl',
    "    redis.call('ZADD', keys[3], reconciled_deadline, values[1])",
    "    return cjson.encode({status='reconciled', deadlineMs=reconciled_deadline})",
    '  end',
    '  local native = nil',
    '  local event_count = 1',
    '  if #keys == 7 then',
    '    local native_ok, decoded_native = pcall(cjson.decode, args[5])',
    "    if not native_ok or type(decoded_native) ~= 'table' or type(args[6]) ~= 'string' or args[6] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if not type_is(keys[6], 'hash') or not type_is(keys[7], 'hash') then",
    "      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '    end',
    '    native = decoded_native',
    '    event_count = 2',
    '  end',
    '  if not stream_has_capacity(keys[4], event_count) or not stream_has_capacity(keys[5], event_count) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local clock = redis_now()',
    '  local native_event = nil',
    '  if native then',
    '    local produced, native_error = native_unlink(keys[6], keys[7], native, values[1], clock, args[6], args[2])',
    "    if native_error then return cjson.encode({status='error', code=native_error}) end",
    '    native_event = produced',
    '  end',
    "  redis.call('HSET', keys[1], 'status', 'disconnected')",
    "  redis.call('DEL', keys[2])",
    "  redis.call('ZREM', keys[3], values[1])",
    '  local event = {',
    "    id=args[3], version=1, type='session.disconnected', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=values[3], agentId=values[2], sessionId=values[1],',
    "    payload={previousStatus=values[4], currentStatus='disconnected'}",
    '  }',
    '  local event_json = cjson.encode(event)',
    '  local streams = append_event(keys[4], keys[5], event_json)',
    '  if not native_event then',
    "    return cjson.encode({status='disconnected', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '  end',
    '  local native_streams = append_event(keys[4], keys[5], cjson.encode(native_event))',
    '  local events = {',
    '    {event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId},',
    '    {event=native_event, globalStreamId=native_streams.globalStreamId, projectStreamId=native_streams.projectStreamId}',
    '  }',
    "  return cjson.encode({status='disconnected', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId, events=events})",
    'end',
    `local function message_keys_match(keys, message, use_idempotency)
  if #keys ~= 15 then return false end
  local prefix = key_namespace(keys[14])
  if prefix == nil then return false end
  local idempotency_part = message.id
  if use_idempotency then idempotency_part = message.idempotencyKeyHash end
  return exact_key(prefix, keys[1], ':message:' .. message.id)
    and exact_key(prefix, keys[2], ':index:message:correlation:' .. message.correlationId)
    and exact_key(prefix, keys[3], ':index:message:idempotency:' .. message.sourceSessionId .. ':' .. idempotency_part)
    and exact_key(prefix, keys[4], ':index:messages')
    and exact_key(prefix, keys[5], ':index:project:' .. message.projectId .. ':messages')
    and exact_key(prefix, keys[6], ':index:session:' .. message.sourceSessionId .. ':messages:source')
    and exact_key(prefix, keys[7], ':index:session:' .. message.targetSessionId .. ':messages:target')
    and exact_key(prefix, keys[8], ':deadline:messages')
    and exact_key(prefix, keys[9], ':session:' .. message.sourceSessionId)
    and exact_key(prefix, keys[10], ':presence:session:' .. message.sourceSessionId)
    and exact_key(prefix, keys[11], ':session:' .. message.targetSessionId)
    and exact_key(prefix, keys[12], ':presence:session:' .. message.targetSessionId)
    and exact_key(prefix, keys[13], ':inbox:session:' .. message.targetSessionId)
    and exact_key(prefix, keys[14], ':events:global')
    and exact_key(prefix, keys[15], ':events:project:' .. message.projectId)
end`,
    'local function message_request(keys, args)',
    '  if #keys ~= 15 or #args ~= 4 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local decoded, message = pcall(cjson.decode, args[1])',
    "  if not decoded or type(message) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local required = {'id', 'correlationId', 'projectId', 'sourceSessionId', 'sourceAgentId', 'targetSessionId', 'targetAgentId', 'selectionReason', 'kind', 'content', 'requestFingerprint'}",
    '  for _, field in ipairs(required) do',
    "    if type(message[field]) ~= 'string' or message[field] == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '  end',
    '  if not bridge_id(message.id) or not bridge_id(message.correlationId) or not bridge_id(message.projectId) or not bridge_id(message.sourceSessionId) or not bridge_id(message.sourceAgentId) or not bridge_id(message.targetSessionId) or not bridge_id(message.targetAgentId) or not bridge_digest(message.requestFingerprint) then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if (message.kind ~= 'question' and message.kind ~= 'status_request' and message.kind ~= 'instruction') or #message.selectionReason > 1024 or string.match(message.selectionReason, '%S') == nil or #message.content > 32768 or string.match(message.content, '%S') == nil then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if message.subject ~= nil and (type(message.subject) ~= 'string' or #message.subject > 512 or string.match(message.subject, '%S') == nil) then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(message.evidenceRequirements) ~= 'table' or type(message.timeoutMs) ~= 'number' or message.timeoutMs < 1 or message.timeoutMs ~= math.floor(message.timeoutMs) or args[2] == '' or args[3] == '' or (args[4] ~= '0' and args[4] ~= '1') then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  if message.timeoutMs > 86400000 or not bridge_id(args[2]) or not bridge_id(args[3]) then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local evidence_count = 0',
    '  local allowed_evidence = {session_state=true, git_commit=true, git_diff=true, test_result=true, build_result=true, file_reference=true, memory_reference=true, other=true}',
    '  for key, value in pairs(message.evidenceRequirements) do',
    "    if type(key) ~= 'number' or key < 1 or key ~= math.floor(key) or not allowed_evidence[value] then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    evidence_count = evidence_count + 1',
    '  end',
    "  if evidence_count > 32 or not message_keys_match(keys, message, args[4] == '1') then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local evidence_requirements_json = next(message.evidenceRequirements) == nil and '[]' or cjson.encode(message.evidenceRequirements)",
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'string') or not type_is(keys[3], 'string') or not type_is(keys[4], 'zset') or not type_is(keys[5], 'zset') or not type_is(keys[6], 'zset') or not type_is(keys[7], 'zset') or not type_is(keys[8], 'zset') or not type_is(keys[9], 'hash') or not type_is(keys[10], 'string') or not type_is(keys[11], 'hash') or not type_is(keys[12], 'string') or not type_is(keys[13], 'stream') or not type_is(keys[14], 'stream') or not type_is(keys[15], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if args[4] == '1' then",
    "    if type(message.idempotencyKeyHash) ~= 'string' or message.idempotencyKeyHash == '' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    local existing_json = redis.call('GET', keys[3])",
    '    if existing_json then',
    '      local valid_existing, existing = pcall(cjson.decode, existing_json)',
    "      if not valid_existing or type(existing) ~= 'table' or type(existing.messageId) ~= 'string' or type(existing.correlationId) ~= 'string' or type(existing.fingerprint) ~= 'string' then",
    "        return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '      end',
    '      if existing.fingerprint ~= message.requestFingerprint then',
    "        return cjson.encode({status='error', code='IDEMPOTENCY_KEY_CONFLICT'})",
    '      end',
    "      return cjson.encode({status='existing', messageId=existing.messageId, correlationId=existing.correlationId})",
    '    end',
    '  end',
    "  if key_type(keys[1]) ~= 'none' or key_type(keys[2]) ~= 'none' then",
    "    return cjson.encode({status='error', code='MESSAGE_ID_CONFLICT'})",
    '  end',
    "  if key_type(keys[9]) == 'none' or key_type(keys[10]) == 'none' then",
    "    return cjson.encode({status='error', code='SOURCE_SESSION_INVALID'})",
    '  end',
    "  if key_type(keys[11]) == 'none' or key_type(keys[12]) == 'none' then",
    "    return cjson.encode({status='error', code='TARGET_SESSION_UNAVAILABLE'})",
    '  end',
    "  local source = redis.call('HMGET', keys[9], 'id', 'agentId', 'projectId', 'status')",
    "  local target = redis.call('HMGET', keys[11], 'id', 'agentId', 'projectId', 'status')",
    "  if source[1] ~= message.sourceSessionId or source[2] ~= message.sourceAgentId or not source[3] or not source[4] or source[4] == 'completed' or source[4] == 'disconnected' then",
    "    return cjson.encode({status='error', code='SOURCE_SESSION_INVALID'})",
    '  end',
    "  if target[1] ~= message.targetSessionId or target[2] ~= message.targetAgentId or not target[3] or not target[4] or target[4] == 'completed' or target[4] == 'disconnected' then",
    "    return cjson.encode({status='error', code='TARGET_SESSION_UNAVAILABLE'})",
    '  end',
    '  if source[3] ~= message.projectId or target[3] ~= message.projectId then',
    "    return cjson.encode({status='error', code='TARGET_PROJECT_MISMATCH'})",
    '  end',
    '  if not stream_appendable(keys[13]) or not stream_appendable(keys[14]) or not stream_appendable(keys[15]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local clock = redis_now()',
    '  local deadline_ms = clock.milliseconds + message.timeoutMs',
    '  local deadline_at = iso_from_milliseconds(deadline_ms)',
    '  local stored = {',
    '    id=message.id, correlationId=message.correlationId, projectId=message.projectId,',
    '    sourceSessionId=message.sourceSessionId, sourceAgentId=message.sourceAgentId,',
    '    targetSessionId=message.targetSessionId, targetAgentId=message.targetAgentId,',
    '    selectionReason=message.selectionReason, kind=message.kind, content=message.content,',
    "    evidenceRequirements=message.evidenceRequirements, state='queued',",
    '    createdAt=clock.timestamp, updatedAt=clock.timestamp, deadlineAt=deadline_at',
    '  }',
    "  if type(message.subject) == 'string' then stored.subject = message.subject end",
    '  local inbox_item = {',
    "    messageId=message.id, correlationId=message.correlationId, itemKind='request',",
    '    sourceSessionId=message.sourceSessionId, targetSessionId=message.targetSessionId,',
    '    createdAt=clock.timestamp, payload={kind=message.kind, content=message.content,',
    '    evidenceRequirements=message.evidenceRequirements, deadlineAt=deadline_at}',
    '  }',
    '  if stored.subject then inbox_item.payload.subject = stored.subject end',
    "  local inbox_stream_id = redis.call('XADD', keys[13], '*', 'item', cjson.encode(inbox_item))",
    '  local event = {',
    "    id=args[3], version=1, type='message.requested', occurredAt=clock.timestamp,",
    '    workspaceId=args[2], projectId=message.projectId, agentId=message.sourceAgentId,',
    '    sessionId=message.sourceSessionId, correlationId=message.correlationId,',
    "    payload={messageId=message.id, kind=message.kind, state='queued', sourceSessionId=message.sourceSessionId, targetSessionId=message.targetSessionId, selectionReason=message.selectionReason}",
    '  }',
    '  local event_json = cjson.encode(event)',
    "  redis.call('HSET', keys[1], 'id', stored.id, 'correlationId', stored.correlationId, 'projectId', stored.projectId, 'sourceSessionId', stored.sourceSessionId, 'sourceAgentId', stored.sourceAgentId, 'targetSessionId', stored.targetSessionId, 'targetAgentId', stored.targetAgentId, 'selectionReason', stored.selectionReason, 'kind', stored.kind, 'content', stored.content, 'evidenceRequirements', evidence_requirements_json, 'state', stored.state, 'createdAt', stored.createdAt, 'updatedAt', stored.updatedAt, 'deadlineAt', stored.deadlineAt, 'deadlineMs', deadline_ms, 'requestFingerprint', message.requestFingerprint, 'targetInboxStreamId', inbox_stream_id)",
    "  if stored.subject then redis.call('HSET', keys[1], 'subject', stored.subject) end",
    "  if args[4] == '1' then redis.call('HSET', keys[1], 'idempotencyKeyHash', message.idempotencyKeyHash) end",
    "  redis.call('SET', keys[2], message.id)",
    "  if args[4] == '1' then redis.call('SET', keys[3], cjson.encode({messageId=message.id, correlationId=message.correlationId, fingerprint=message.requestFingerprint})) end",
    "  redis.call('ZADD', keys[4], clock.milliseconds, message.id)",
    "  redis.call('ZADD', keys[5], clock.milliseconds, message.id)",
    "  redis.call('ZADD', keys[6], clock.milliseconds, message.id)",
    "  redis.call('ZADD', keys[7], clock.milliseconds, message.id)",
    "  redis.call('ZADD', keys[8], deadline_ms, message.id)",
    '  local streams = append_event(keys[14], keys[15], event_json)',
    "  return cjson.encode({status='created', message=stored, event=event, inboxStreamId=inbox_stream_id, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    `local function workflow_create(keys, args)
  if #keys ~= 21 or #args ~= 4 then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  local workflow_ok, workflow = pcall(cjson.decode, args[1])
  local message_ok, message = pcall(cjson.decode, args[2])
  if not workflow_ok or type(workflow) ~= 'table' or not message_ok or type(message) ~= 'table' then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if not bridge_id(workflow.id) or not bridge_id(workflow.projectId)
    or not bridge_id(workflow.coordinatorSessionId) or not bridge_id(workflow.rootCorrelationId)
    or type(workflow.objective) ~= 'string' or #workflow.objective > 4000
    or string.match(workflow.objective, '%S') == nil or not bridge_digest(workflow.createFingerprint) then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if not bridge_id(message.id) or not bridge_id(message.correlationId)
    or not bridge_id(message.projectId) or not bridge_id(message.sourceSessionId)
    or not bridge_id(message.targetSessionId) or message.idempotencyKeyHash ~= nil then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if workflow.projectId ~= message.projectId
    or workflow.coordinatorSessionId ~= message.sourceSessionId
    or workflow.rootCorrelationId ~= message.correlationId then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  local message_keys = {}
  for index = 1, 15 do message_keys[index] = keys[index + 6] end
  local prefix = key_namespace(keys[20])
  if prefix == nil
    or not exact_key(prefix, keys[1], ':workflow:' .. workflow.id)
    or not exact_key(prefix, keys[2], ':index:workflow:root-correlation:' .. workflow.rootCorrelationId)
    or not exact_key(prefix, keys[3], ':index:workflows')
    or not exact_key(prefix, keys[4], ':index:project:' .. workflow.projectId .. ':workflows')
    or not exact_key(prefix, keys[5], ':index:session:' .. workflow.coordinatorSessionId .. ':workflows:coordinator')
    or not exact_key(prefix, keys[6], ':index:workflow:' .. workflow.id .. ':messages')
    or not message_keys_match(message_keys, message, false) then
    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})
  end
  if not type_is(keys[2], 'string') then
    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})
  end
  local receipt_json = redis.call('GET', keys[2])
  if receipt_json then
    local receipt_ok, receipt = pcall(cjson.decode, receipt_json)
    if not receipt_ok or type(receipt) ~= 'table' or not bridge_id(receipt.workflowId)
      or not bridge_id(receipt.messageId) or not bridge_digest(receipt.fingerprint) then
      return cjson.encode({status='error', code='REDIS_STATE_INVALID'})
    end
    if receipt.fingerprint ~= workflow.createFingerprint then
      return cjson.encode({status='error', code='WORKFLOW_CREATE_CONFLICT'})
    end
    return cjson.encode({status='existing', workflowId=receipt.workflowId, messageId=receipt.messageId})
  end
  if not type_is(keys[1], 'hash') or not type_is(keys[3], 'zset')
    or not type_is(keys[4], 'zset') or not type_is(keys[5], 'zset')
    or not type_is(keys[6], 'zset') then
    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})
  end
  if key_type(keys[1]) ~= 'none' then
    return cjson.encode({status='error', code='WORKFLOW_CREATE_CONFLICT'})
  end
  local message_result_json = message_request(message_keys, {args[2], args[3], args[4], '0'})
  local result_ok, message_result = pcall(cjson.decode, message_result_json)
  if not result_ok or type(message_result) ~= 'table' then
    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})
  end
  if message_result.status ~= 'created' then return message_result_json end
  local clock = redis_now()
  local stored_workflow = {
    id=workflow.id, projectId=workflow.projectId,
    coordinatorSessionId=workflow.coordinatorSessionId,
    rootCorrelationId=workflow.rootCorrelationId, objective=workflow.objective,
    revision=1, state='active', currentMessageId=message.id,
    createdAt=message_result.message.createdAt, updatedAt=message_result.message.createdAt
  }
  redis.call('HSET', keys[1], 'id', stored_workflow.id, 'projectId', stored_workflow.projectId,
    'coordinatorSessionId', stored_workflow.coordinatorSessionId,
    'rootCorrelationId', stored_workflow.rootCorrelationId, 'objective', stored_workflow.objective,
    'revision', 1, 'state', 'active', 'currentMessageId', stored_workflow.currentMessageId,
    'createdAt', stored_workflow.createdAt, 'updatedAt', stored_workflow.updatedAt,
    'createFingerprint', workflow.createFingerprint)
  redis.call('HSET', keys[7], 'workflowId', workflow.id, 'workflowRevision', 1)
  redis.call('ZADD', keys[3], clock.milliseconds, workflow.id)
  redis.call('ZADD', keys[4], clock.milliseconds, workflow.id)
  redis.call('ZADD', keys[5], clock.milliseconds, workflow.id)
  redis.call('ZADD', keys[6], 1, message.id)
  redis.call('SET', keys[2], cjson.encode({workflowId=workflow.id, messageId=message.id, fingerprint=workflow.createFingerprint}))
  return cjson.encode({status='created', workflow=stored_workflow, message=message_result.message})
end`,
    'local function message_projection(key)',
    "  local fields = redis.call('HGETALL', key)",
    '  if #fields == 0 then return nil end',
    '  local raw = {}',
    '  for index = 1, #fields, 2 do raw[fields[index]] = fields[index + 1] end',
    "  local evidence_ok, evidence = pcall(cjson.decode, raw.evidenceRequirements or '')",
    "  if not evidence_ok or type(evidence) ~= 'table' then return nil end",
    '  local result = {',
    '    id=raw.id, correlationId=raw.correlationId, projectId=raw.projectId,',
    '    sourceSessionId=raw.sourceSessionId, sourceAgentId=raw.sourceAgentId,',
    '    targetSessionId=raw.targetSessionId, targetAgentId=raw.targetAgentId,',
    '    selectionReason=raw.selectionReason, kind=raw.kind, content=raw.content,',
    '    evidenceRequirements=evidence, state=raw.state, createdAt=raw.createdAt,',
    '    updatedAt=raw.updatedAt, deadlineAt=raw.deadlineAt',
    '  }',
    '  if raw.subject then result.subject = raw.subject end',
    '  if raw.acknowledgedAt then result.acknowledgedAt = raw.acknowledgedAt end',
    '  if raw.processingAt then result.processingAt = raw.processingAt end',
    '  if raw.respondedAt then result.respondedAt = raw.respondedAt end',
    '  if raw.response then',
    '    local response_ok, response = pcall(cjson.decode, raw.response)',
    "    if not response_ok or type(response) ~= 'table' then return nil end",
    '    result.response = response',
    '  end',
    '  return result',
    'end',
    'local function message_transition(keys, args, target_state)',
    '  if #keys ~= 10 or #args ~= 9 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'stream') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') or not type_is(keys[6], 'stream') or not type_is(keys[7], 'zset') or not type_is(keys[8], 'zset') or not type_is(keys[9], 'string') or not type_is(keys[10], 'string') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then",
    "    return cjson.encode({status='error', code='MESSAGE_NOT_FOUND'})",
    '  end',
    "  if args[1] == '' or args[3] == '' or args[4] == '' or args[7] == '' or args[8] == '' or (args[9] ~= '0' and args[9] ~= '1') then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local values = redis.call('HMGET', keys[1], 'id', 'correlationId', 'projectId', 'sourceSessionId', 'sourceAgentId', 'targetSessionId', 'targetAgentId', 'state', 'targetInboxStreamId')",
    '  for index = 1, 9 do',
    "    if not values[index] or values[index] == '' then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  end',
    '  if values[2] ~= args[1] then',
    "    return cjson.encode({status='error', code='MESSAGE_NOT_FOUND'})",
    '  end',
    '  local current = values[8]',
    '  local projection = message_projection(keys[1])',
    "  if not projection then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  local terminal = {responded=true, rejected=true, timed_out=true, failed=true}',
    "  if target_state ~= 'timed_out' then",
    "    if args[2] == '' or args[2] ~= values[6] or key_type(keys[2]) == 'none' then",
    "      return cjson.encode({status='error', code='RESPONDER_SESSION_MISMATCH'})",
    '    end',
    "    local responder = redis.call('HMGET', keys[2], 'id', 'status')",
    '    if responder[1] ~= values[6] or not responder[2] then',
    "      return cjson.encode({status='error', code='RESPONDER_SESSION_MISMATCH'})",
    '    end',
    "    if current ~= target_state and (responder[2] == 'completed' or responder[2] == 'disconnected') then",
    "      return cjson.encode({status='error', code='RESPONDER_SESSION_MISMATCH'})",
    '    end',
    '  end',
    '  if current == target_state then',
    "    return cjson.encode({status='unchanged', message=projection})",
    '  end',
    '  if terminal[current] then',
    "    if target_state == 'timed_out' then return cjson.encode({status='unchanged', message=projection}) end",
    "    return cjson.encode({status='error', code='MESSAGE_TERMINAL'})",
    '  end',
    '  local allowed = {',
    '    queued={delivered=true, timed_out=true, failed=true},',
    '    delivered={acknowledged=true, processing=true, responded=true, rejected=true, timed_out=true, failed=true},',
    '    acknowledged={processing=true, responded=true, rejected=true, timed_out=true, failed=true},',
    '    processing={responded=true, rejected=true, timed_out=true, failed=true}',
    '  }',
    '  if not allowed[current] or not allowed[current][target_state] then',
    "    return cjson.encode({status='error', code='MESSAGE_TRANSITION_INVALID'})",
    '  end',
    '  local clock = redis_now()',
    "  if target_state == 'timed_out' then",
    '    local expected_deadline = tonumber(args[6])',
    "    local stored_deadline = redis.call('ZSCORE', keys[7], values[1])",
    '    if not expected_deadline or not stored_deadline or tonumber(stored_deadline) ~= expected_deadline or clock.milliseconds < expected_deadline then',
    "      return cjson.encode({status='unchanged', message=projection})",
    '    end',
    '  end',
    '  local response = nil',
    "  if target_state == 'responded' or target_state == 'rejected' or target_state == 'failed' then",
    '    local response_ok',
    '    response_ok, response = pcall(cjson.decode, args[5])',
    "    if not response_ok or type(response) ~= 'table' or type(response.status) ~= 'string' or type(response.answer) ~= 'string' or response.answer == '' or type(response.evidence) ~= 'table' or type(response.verifiedAt) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if target_state == 'responded' and response.status ~= 'answered' and response.status ~= 'partially_answered' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    "    if target_state == 'rejected' and response.status ~= 'rejected' then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    "    if target_state == 'failed' and response.status ~= 'failed' then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    '  elseif args[5] ~= "" then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local terminal_target = terminal[target_state] == true',
    '  if not stream_appendable(keys[3]) or not stream_appendable(keys[4]) or (terminal_target and not stream_appendable(keys[6])) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'state', target_state, 'updatedAt', clock.timestamp)",
    "  if target_state == 'acknowledged' then redis.call('HSET', keys[1], 'acknowledgedAt', clock.timestamp) end",
    "  if target_state == 'processing' then redis.call('HSET', keys[1], 'processingAt', clock.timestamp) end",
    "  if target_state == 'responded' then redis.call('HSET', keys[1], 'respondedAt', clock.timestamp) end",
    "  if response then redis.call('HSET', keys[1], 'response', args[5]) end",
    '  if terminal_target then',
    "    redis.call('ZREM', keys[7], values[1])",
    "    redis.call('ZADD', keys[8], clock.milliseconds, values[1])",
    '    local notification = {',
    "      messageId=values[1], correlationId=values[2], itemKind='response',",
    '      sourceSessionId=values[6], targetSessionId=values[4], createdAt=clock.timestamp,',
    '      payload={state=target_state}',
    '    }',
    '    if response then notification.payload.response = response end',
    "    redis.call('XADD', keys[6], '*', 'item', cjson.encode(notification))",
    "    redis.call('XACK', keys[5], args[8], values[9])",
    "    if args[9] == '1' then redis.call('PEXPIRE', keys[9], tonumber(args[7])) end",
    '  end',
    '  local event_types = {',
    "    delivered='message.delivered', acknowledged='message.acknowledged',",
    "    processing='message.processing', responded='message.responded',",
    "    rejected='message.rejected', failed='message.failed', timed_out='message.timed_out'",
    '  }',
    '  local event = {',
    '    id=args[4], version=1, type=event_types[target_state], occurredAt=clock.timestamp,',
    '    workspaceId=args[3], projectId=values[3], agentId=values[7], sessionId=values[6],',
    '    correlationId=values[2], payload={messageId=values[1], previousState=current, currentState=target_state}',
    '  }',
    '  local streams = append_event(keys[3], keys[4], cjson.encode(event))',
    '  local updated = message_projection(keys[1])',
    "  if not updated then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    "  return cjson.encode({status='updated', message=updated, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    "local function message_delivered(keys, args) return message_transition(keys, args, 'delivered') end",
    "local function message_acknowledge(keys, args) return message_transition(keys, args, 'acknowledged') end",
    "local function message_processing(keys, args) return message_transition(keys, args, 'processing') end",
    "local function message_respond(keys, args) return message_transition(keys, args, 'responded') end",
    "local function message_reject(keys, args) return message_transition(keys, args, 'rejected') end",
    "local function message_fail(keys, args) return message_transition(keys, args, 'failed') end",
    "local function message_timeout(keys, args) return message_transition(keys, args, 'timed_out') end",
    'local function control_append_event(global_stream, project_stream, event_json)',
    "  local global_stream_id = redis.call('XADD', global_stream, '*', 'event', event_json)",
    '  local project_stream_id = global_stream_id',
    '  if project_stream ~= global_stream then',
    "    project_stream_id = redis.call('XADD', project_stream, '*', 'event', event_json)",
    '  end',
    '  return {globalStreamId=global_stream_id, projectStreamId=project_stream_id}',
    'end',
    // Work leases.
    //
    // Path normalization, case folding and the trailing-separator convention
    // live in `@luwi/protocol`; what happens here is only the part that has to
    // be atomic — compare already-normalized match forms against the project's
    // held leases and either write the record with its event, or refuse with
    // the holder. Every key it touches is declared, so nothing is derived from
    // another key's name.
    //
    // The project's held leases are one hash keyed by lease id, whose values
    // carry just enough to answer a conflict: match form, holder, and expiry.
    // That is what keeps the scan to a single declared key.
    'local function lease_overlaps(left, right)',
    '  return string.sub(left, 1, string.len(right)) == right or string.sub(right, 1, string.len(left)) == left',
    'end',
    'local function lease_acquire(keys, args)',
    '  if #keys ~= 6 or #args ~= 6 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'set') or not type_is(keys[4], 'zset') or not type_is(keys[5], 'stream') or not type_is(keys[6], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local lease_ok, lease = pcall(cjson.decode, args[1])',
    '  local granted_ok, granted_event = pcall(cjson.decode, args[2])',
    '  local denied_ok, denied_event = pcall(cjson.decode, args[3])',
    "  if not lease_ok or type(lease) ~= 'table' or not granted_ok or type(granted_event) ~= 'table' or not denied_ok or type(denied_event) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if type(lease.id) ~= 'string' or lease.id == '' or type(lease.matchPath) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local now_ms = tonumber(args[4])',
    '  local expires_ms = tonumber(args[5])',
    '  local max_active = tonumber(args[6])',
    '  if not now_ms or not expires_ms or not max_active then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if key_type(keys[1]) ~= 'none' then return cjson.encode({status='conflict'}) end",
    '  if not stream_appendable(keys[5]) or not stream_appendable(keys[6]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  local held = redis.call('HGETALL', keys[2])",
    '  local active = 0',
    '  for index = 2, #held, 2 do',
    '    local other_ok, other = pcall(cjson.decode, held[index])',
    "    if other_ok and type(other) == 'table' and type(other.matchPath) == 'string' then",
    // An entry past its expiry is ignored rather than deleted: removing it is
    // the sweep's job, and the sweep owns the `lease.expired` event with it.
    '      local other_expiry = tonumber(other.expiresMs)',
    '      if other_expiry and other_expiry > now_ms then',
    '        active = active + 1',
    '        if lease_overlaps(lease.matchPath, other.matchPath) then',
    '          local streams = control_append_event(keys[5], keys[6], args[3])',
    // The conflict is built field by field rather than returned as the stored
    // detail record: the detail carries the match form and a numeric expiry
    // that the wire contract does not have, and that contract is strict.
    '          local conflict = {leaseId=other.leaseId, sessionId=other.sessionId, agentId=other.agentId, path=other.path, reason=other.reason, expiresAt=other.expiresAt}',
    "          return cjson.encode({status='denied', conflict=conflict, event=denied_event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    '        end',
    '      end',
    '    end',
    '  end',
    '  if active >= max_active then',
    "    return cjson.encode({status='error', code='LEASE_LIMIT_REACHED'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', lease.id, 'json', args[1])",
    "  redis.call('HSET', keys[2], lease.id, cjson.encode({leaseId=lease.id, matchPath=lease.matchPath, path=lease.path, sessionId=lease.sessionId, agentId=lease.agentId, reason=lease.reason, expiresAt=lease.expiresAt, expiresMs=expires_ms}))",
    "  redis.call('SADD', keys[3], lease.id)",
    "  redis.call('ZADD', keys[4], expires_ms, lease.id)",
    '  local streams = control_append_event(keys[5], keys[6], args[2])',
    "  return cjson.encode({status='granted', lease=lease, event=granted_event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function lease_transition(keys, args, stays_held)',
    '  if #keys ~= 6 or #args ~= 5 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'set') or not type_is(keys[4], 'zset') or not type_is(keys[5], 'stream') or not type_is(keys[6], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then return cjson.encode({status='not_found'}) end",
    "  local current_json = redis.call('HGET', keys[1], 'json')",
    '  local current_ok, current = pcall(cjson.decode, current_json or "")',
    "  if not current_ok or type(current) ~= 'table' then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if current.state ~= 'held' then return cjson.encode({status='state_conflict', lease=current}) end",
    // Only the holder renews or releases. A lease another session can drop is
    // not a lease. The sweep passes an empty holder because expiry is the
    // runtime's own transition, not a caller's.
    "  if args[1] ~= '' and current.sessionId ~= args[1] then",
    "    return cjson.encode({status='not_holder', lease=current})",
    '  end',
    '  local updated_ok, updated = pcall(cjson.decode, args[2])',
    '  local event_ok, event = pcall(cjson.decode, args[3])',
    "  if not updated_ok or type(updated) ~= 'table' or not event_ok or type(event) ~= 'table' or updated.id ~= current.id then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  if not stream_appendable(keys[5]) or not stream_appendable(keys[6]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local expires_ms = tonumber(args[4])',
    "  redis.call('HSET', keys[1], 'id', updated.id, 'json', args[2])",
    "  if stays_held == 'held' and expires_ms then",
    "    redis.call('HSET', keys[2], updated.id, cjson.encode({leaseId=updated.id, matchPath=updated.matchPath, path=updated.path, sessionId=updated.sessionId, agentId=updated.agentId, reason=updated.reason, expiresAt=updated.expiresAt, expiresMs=expires_ms}))",
    "    redis.call('ZADD', keys[4], expires_ms, updated.id)",
    '  else',
    "    redis.call('HDEL', keys[2], updated.id)",
    "    redis.call('SREM', keys[3], updated.id)",
    "    redis.call('ZREM', keys[4], updated.id)",
    '  end',
    '  local streams = control_append_event(keys[5], keys[6], args[3])',
    "  return cjson.encode({status='updated', lease=updated, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    "local function lease_renew(keys, args) return lease_transition(keys, args, 'held') end",
    "local function lease_release(keys, args) return lease_transition(keys, args, 'closed') end",
    "local function lease_expire(keys, args) return lease_transition(keys, args, 'closed') end",
    'local function control_upsert(keys, args)',
    '  if #keys < 4 or #args ~= 4 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'set') or not type_is(keys[3], 'stream') or not type_is(keys[4], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  for index = 5, #keys do',
    "    if not type_is(keys[index], 'set') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  end',
    "  if args[1] ~= 'create' and args[1] ~= 'update' and args[1] ~= 'upsert' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  local entity_ok, entity = pcall(cjson.decode, args[2])',
    '  local event_ok, event = pcall(cjson.decode, args[3])',
    "  if not entity_ok or type(entity) ~= 'table' or not event_ok or type(event) ~= 'table' or type(entity.id) ~= 'string' or entity.id ~= args[4] or type(event.id) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local exists = key_type(keys[1]) ~= 'none'",
    "  if args[1] == 'create' and exists then return cjson.encode({status='conflict'}) end",
    "  if args[1] == 'update' and not exists then return cjson.encode({status='not_found'}) end",
    '  if not stream_appendable(keys[3]) or not stream_appendable(keys[4]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', entity.id, 'json', args[2])",
    "  redis.call('SADD', keys[2], entity.id)",
    "  for index = 5, #keys do redis.call('SADD', keys[index], entity.id) end",
    '  local streams = control_append_event(keys[3], keys[4], args[3])',
    "  return cjson.encode({status=exists and 'updated' or 'created', entity=entity, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function control_delete(keys, args)',
    '  if #keys < 4 or #args ~= 3 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'set') or not type_is(keys[3], 'stream') or not type_is(keys[4], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then return cjson.encode({status='not_found'}) end",
    '  local entity_ok, entity = pcall(cjson.decode, args[1])',
    '  local event_ok, event = pcall(cjson.decode, args[2])',
    "  if not entity_ok or type(entity) ~= 'table' or not event_ok or type(event) ~= 'table' or type(entity.id) ~= 'string' or entity.id ~= args[3] then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  if not stream_appendable(keys[3]) or not stream_appendable(keys[4]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('DEL', keys[1])",
    "  redis.call('SREM', keys[2], entity.id)",
    "  for index = 5, #keys do redis.call('SREM', keys[index], entity.id) end",
    '  local streams = control_append_event(keys[3], keys[4], args[2])',
    "  return cjson.encode({status='deleted', entity=entity, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function control_plan_transition(keys, args)',
    '  if #keys ~= 4 or #args ~= 6 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'stream') or not type_is(keys[3], 'stream') or not type_is(keys[4], 'zset') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local plan_ok, plan = pcall(cjson.decode, args[2])',
    '  local event_ok, event = pcall(cjson.decode, args[3])',
    "  if not plan_ok or type(plan) ~= 'table' or not event_ok or type(event) ~= 'table' or type(plan.id) ~= 'string' or plan.id ~= args[4] or type(plan.state) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  local exists = key_type(keys[1]) ~= 'none'",
    "  if args[1] == '__missing__' then",
    "    if exists then return cjson.encode({status='conflict'}) end",
    '  else',
    "    if not exists then return cjson.encode({status='not_found'}) end",
    "    local previous_json = redis.call('HGET', keys[1], 'json')",
    '    local previous_ok, previous = pcall(cjson.decode, previous_json or "")',
    "    if not previous_ok or type(previous) ~= 'table' or previous.state ~= args[1] then",
    "      return cjson.encode({status='state_conflict'})",
    '    end',
    '  end',
    '  if not stream_appendable(keys[2]) or not stream_appendable(keys[3]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', plan.id, 'json', args[2])",
    '  local expiry = tonumber(args[5])',
    "  if args[6] == 'track' and expiry and expiry > 0 then",
    "    redis.call('ZADD', keys[4], expiry, plan.id)",
    '  else',
    "    redis.call('ZREM', keys[4], plan.id)",
    '  end',
    '  local streams = control_append_event(keys[2], keys[3], args[3])',
    "  return cjson.encode({status=exists and 'updated' or 'created', plan=plan, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function control_plan_complete(keys, args)',
    '  if #keys ~= 6 or #args ~= 6 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'set') or not type_is(keys[4], 'stream') or not type_is(keys[5], 'stream') or not type_is(keys[6], 'zset') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if key_type(keys[1]) == 'none' then return cjson.encode({status='not_found'}) end",
    "  if key_type(keys[2]) ~= 'none' then return cjson.encode({status='conflict'}) end",
    "  local previous_json = redis.call('HGET', keys[1], 'json')",
    '  local previous_ok, previous = pcall(cjson.decode, previous_json or "")',
    "  if not previous_ok or type(previous) ~= 'table' or previous.state ~= args[1] then",
    "    return cjson.encode({status='state_conflict'})",
    '  end',
    '  local plan_ok, plan = pcall(cjson.decode, args[2])',
    '  local operation_ok, operation = pcall(cjson.decode, args[3])',
    '  local event_ok, event = pcall(cjson.decode, args[4])',
    "  if not plan_ok or type(plan) ~= 'table' or not operation_ok or type(operation) ~= 'table' or not event_ok or type(event) ~= 'table' or type(plan.id) ~= 'string' or plan.id ~= args[5] or type(operation.id) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  if not stream_appendable(keys[4]) or not stream_appendable(keys[5]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', plan.id, 'json', args[2])",
    "  redis.call('HSET', keys[2], 'id', operation.id, 'json', args[3])",
    "  redis.call('SADD', keys[3], operation.id)",
    '  local expiry = tonumber(args[6])',
    "  if expiry and expiry > 0 then redis.call('ZADD', keys[6], expiry, plan.id) end",
    '  local streams = control_append_event(keys[4], keys[5], args[4])',
    "  return cjson.encode({status='updated', plan=plan, operation=operation, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function usage_ingest(keys, args)',
    '  if #keys ~= 16 or #args ~= 6 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'hash') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  for index = 2, 5 do',
    "    if not type_is(keys[index], 'set') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  end',
    "  if not type_is(keys[6], 'string') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  for index = 7, 14 do',
    "    if not type_is(keys[index], 'hash') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  end',
    "  if not type_is(keys[15], 'stream') or not type_is(keys[16], 'stream') then return cjson.encode({status='error', code='REDIS_STATE_INVALID'}) end",
    '  local record_ok, record = pcall(cjson.decode, args[1])',
    '  local event_ok, event = pcall(cjson.decode, args[2])',
    '  local deltas_ok, deltas = pcall(cjson.decode, args[6])',
    "  if not record_ok or type(record) ~= 'table' or not event_ok or type(event) ~= 'table' or not deltas_ok or type(deltas) ~= 'table' or type(record.id) ~= 'string' or record.id ~= args[3] or type(event.id) ~= 'string' or type(args[5]) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  for field, delta in pairs(deltas) do',
    "    if type(field) ~= 'string' or type(delta) ~= 'number' or delta < 0 or delta % 1 ~= 0 then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    '  end',
    "  if key_type(keys[1]) ~= 'none' then return cjson.encode({status='duplicate', existingUsageId=record.id}) end",
    "  if args[4] ~= '' and key_type(keys[6]) ~= 'none' then",
    "    return cjson.encode({status='duplicate', existingUsageId=redis.call('GET', keys[6])})",
    '  end',
    '  if not stream_appendable(keys[15]) or not stream_appendable(keys[16]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  redis.call('HSET', keys[1], 'id', record.id, 'json', args[1])",
    "  for index = 2, 5 do redis.call('SADD', keys[index], record.id) end",
    "  if args[4] ~= '' then redis.call('SET', keys[6], record.id) end",
    '  for index = 7, 14 do',
    "    redis.call('HINCRBY', keys[index], 'recordCount', 1)",
    "    local earliest = redis.call('HGET', keys[index], 'observedFrom')",
    "    local latest = redis.call('HGET', keys[index], 'observedTo')",
    "    if not earliest or args[5] < earliest then redis.call('HSET', keys[index], 'observedFrom', args[5]) end",
    "    if not latest or args[5] > latest then redis.call('HSET', keys[index], 'observedTo', args[5]) end",
    '    for field, delta in pairs(deltas) do',
    "      redis.call('HINCRBY', keys[index], field, delta)",
    '    end',
    '  end',
    '  local streams = control_append_event(keys[15], keys[16], args[2])',
    "  return cjson.encode({status='created', usage=record, event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function intelligence_batch_transition(keys, args)',
    '  if #keys < 2 or #args ~= 2 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'stream') or not type_is(keys[2], 'stream') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local operations_ok, operations = pcall(cjson.decode, args[1])',
    '  local event_ok, event = pcall(cjson.decode, args[2])',
    "  if not operations_ok or type(operations) ~= 'table' or #operations > 100000 or not event_ok or type(event) ~= 'table' or type(event.id) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  for _, operation in ipairs(operations) do',
    "    if type(operation) ~= 'table' or type(operation.key) ~= 'number' or operation.key % 1 ~= 0 or operation.key < 3 or operation.key > #keys or type(operation.kind) ~= 'string' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '    local key = keys[operation.key]',
    "    if operation.kind == 'hash_json' then",
    "      if type(operation.id) ~= 'string' or operation.id == '' or type(operation.json) ~= 'string' or not type_is(key, 'hash') then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    "    elseif operation.kind == 'set_add' or operation.kind == 'set_remove' then",
    "      if type(operation.member) ~= 'string' or operation.member == '' or not type_is(key, 'set') then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    "    elseif operation.kind ~= 'delete' then",
    "      return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '    end',
    '  end',
    '  if not stream_appendable(keys[1]) or not stream_appendable(keys[2]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  for _, operation in ipairs(operations) do',
    '    local key = keys[operation.key]',
    "    if operation.kind == 'hash_json' then",
    "      redis.call('HSET', key, 'id', operation.id, 'json', operation.json)",
    "    elseif operation.kind == 'set_add' then",
    "      redis.call('SADD', key, operation.member)",
    "    elseif operation.kind == 'set_remove' then",
    "      redis.call('SREM', key, operation.member)",
    '    else',
    "      redis.call('DEL', key)",
    '    end',
    '  end',
    '  local streams = control_append_event(keys[1], keys[2], args[2])',
    "  return cjson.encode({status='updated', event=event, globalStreamId=streams.globalStreamId, projectStreamId=streams.projectStreamId})",
    'end',
    'local function graph_projection_failure(keys, args)',
    '  if #keys ~= 2 or #args ~= 1 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'stream') or not type_is(keys[2], 'string') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local failure_ok, failure = pcall(cjson.decode, args[1])',
    "  if not failure_ok or type(failure) ~= 'table' or type(failure.id) ~= 'string' or failure.id == '' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    '  if not stream_appendable(keys[1]) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  local stream_id = redis.call('XADD', keys[1], 'MAXLEN', '~', 1000, '*', 'failure', args[1])",
    "  redis.call('SET', keys[2], 'degraded')",
    "  return cjson.encode({status='updated', streamId=stream_id})",
    'end',
    'local function graph_rebuild_transition(keys, args)',
    '  if (#keys ~= 6 and #keys ~= 7) or #args ~= 3 then',
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if not type_is(keys[1], 'string') or not type_is(keys[2], 'hash') or not type_is(keys[3], 'set') or not type_is(keys[4], 'string') or not type_is(keys[5], 'string') then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if not type_is(keys[6], 'stream') or (#keys == 7 and not type_is(keys[7], 'stream')) then",
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    '  local operation_ok, operation = pcall(cjson.decode, args[1])',
    '  local event_ok, event = pcall(cjson.decode, args[2])',
    "  if not operation_ok or type(operation) ~= 'table' or not event_ok or type(event) ~= 'table' or type(operation.id) ~= 'string' or operation.id ~= args[3] or type(event.id) ~= 'string' then",
    "    return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'})",
    '  end',
    "  if operation.state ~= 'completed' and operation.state ~= 'failed' then",
    "    return cjson.encode({status='error', code='GRAPH_REBUILD_FAILED'})",
    '  end',
    "  if redis.call('GET', keys[4]) ~= args[3] then",
    "    return cjson.encode({status='error', code='GRAPH_REBUILD_OWNERSHIP_LOST'})",
    '  end',
    '  if not stream_appendable(keys[6]) or (#keys == 7 and not stream_appendable(keys[7])) then',
    "    return cjson.encode({status='error', code='REDIS_STATE_INVALID'})",
    '  end',
    "  if operation.state == 'completed' then",
    "    if type(operation.shadowGeneration) ~= 'string' then return cjson.encode({status='error', code='REDIS_ARGUMENT_INVALID'}) end",
    "    redis.call('SET', keys[1], operation.shadowGeneration)",
    "    redis.call('SET', keys[5], 'healthy')",
    '  else',
    "    redis.call('SET', keys[5], 'degraded')",
    '  end',
    "  redis.call('HSET', keys[2], 'id', operation.id, 'json', args[1])",
    "  redis.call('SADD', keys[3], operation.id)",
    "  redis.call('DEL', keys[4])",
    "  local global_stream_id = redis.call('XADD', keys[6], '*', 'event', args[2])",
    '  local project_stream_id = nil',
    "  if #keys == 7 then project_stream_id = redis.call('XADD', keys[7], '*', 'event', args[2]) end",
    "  return cjson.encode({status='updated', operation=operation, event=event, globalStreamId=global_stream_id, projectStreamId=project_stream_id})",
    'end',
    'local function not_implemented(keys, args)',
    "  return cjson.encode({status='not_implemented'})",
    'end',
    'local function library_version(keys, args)',
    `  return cjson.encode({version=${registry.version}, libraryName='${registry.libraryName}'})`,
    'end',
    register(registry.functions.projectRegister, 'project_register'),
    register(registry.functions.sessionRegister, 'session_register'),
    register(registry.functions.bridgeSlotAcquire, 'bridge_slot_acquire'),
    register(registry.functions.bridgeSlotRenew, 'bridge_slot_renew'),
    register(registry.functions.bridgeSlotAttach, 'bridge_slot_attach'),
    register(registry.functions.bridgeSlotRelease, 'bridge_slot_release'),
    register(registry.functions.bridgeSlotExpire, 'bridge_slot_expire'),
    register(registry.functions.sessionHeartbeat, 'session_heartbeat'),
    register(registry.functions.sessionStatus, 'session_status'),
    register(registry.functions.sessionClose, 'session_close'),
    register(registry.functions.sessionDisconnect, 'session_disconnect'),
    register(registry.functions.nativeLinkTrim, 'native_link_trim'),
    register(registry.functions.nativeDeclare, 'native_declare'),
    register(registry.functions.workflowCreate, 'workflow_create'),
    register(registry.functions.messageRequest, 'message_request'),
    register(registry.functions.messageDelivered, 'message_delivered'),
    register(registry.functions.messageAcknowledge, 'message_acknowledge'),
    register(registry.functions.messageProcessing, 'message_processing'),
    register(registry.functions.messageRespond, 'message_respond'),
    register(registry.functions.messageReject, 'message_reject'),
    register(registry.functions.messageFail, 'message_fail'),
    register(registry.functions.messageTimeout, 'message_timeout'),
    register(registry.functions.leaseAcquire, 'lease_acquire'),
    register(registry.functions.leaseRenew, 'lease_renew'),
    register(registry.functions.leaseRelease, 'lease_release'),
    register(registry.functions.leaseExpire, 'lease_expire'),
    register(registry.functions.controlUpsert, 'control_upsert'),
    register(registry.functions.controlDelete, 'control_delete'),
    register(registry.functions.controlPlanTransition, 'control_plan_transition'),
    register(registry.functions.controlPlanComplete, 'control_plan_complete'),
    register(registry.functions.usageIngest, 'usage_ingest'),
    register(registry.functions.graphRebuildTransition, 'graph_rebuild_transition'),
    register(registry.functions.intelligenceBatchTransition, 'intelligence_batch_transition'),
    register(registry.functions.graphProjectionFailure, 'graph_projection_failure'),
    register(registry.functions.version, 'library_version'),
    '',
  ].join('\n');

  return {
    registry,
    source,
    contentHash: createHash('sha256').update(source).digest('hex'),
  };
}
