// Pure rotation logic for the daily "דור תרד" roast (no I/O — unit-tested).

import { selectRotate } from '../../../shared/lib/cron-feed.mjs';

/**
 * Pick the next group member to roast and advance the rotation. Thin wrapper over the shared
 * `rotate` strategy (selectRotate) — cycle-free {next_index} state, so dor-teder-state.json's
 * on-disk shape is unchanged. Keeps its own empty-roster message + {member,index,nextState} shape.
 * @param {Array<{name:string,e164:string}>} members
 * @param {{next_index?:number}} state
 * @returns {{member:object, index:number, nextState:{next_index:number}}}
 */
export function pickMember(members, state = {}) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error('no members to roast');
  }
  const { item, index, nextState } = selectRotate(members, state);
  return { member: item, index, nextState };
}

/**
 * Pull the roster note lines that mention a member (by name or phone).
 * @param {string} rosterText  full roster.md contents
 * @param {{name:string,e164:string}} member
 * @returns {string} matching lines joined, or '' if none
 */
export function rosterNotesFor(rosterText, member) {
  if (typeof rosterText !== 'string' || !rosterText) return '';
  const phone = (member.e164 || '').replace(/[^0-9]/g, '');
  return rosterText
    .split('\n')
    .filter((line) => {
      if (member.name && line.includes(member.name)) return true;
      if (phone && line.replace(/[^0-9]/g, '').includes(phone)) return true;
      return false;
    })
    .join('\n')
    .trim();
}
