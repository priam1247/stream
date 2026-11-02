'use strict';

/**
 * commands/paper/config.js — Drime settings, read from the environment only.
 *
 * Own copy for .paper. The old bot read these from the shared config.js; a
 * command may not import the gateway, so it reads the environment directly.
 */

const env = process.env;

const drime = {
  apiToken: env.DRIME_API_TOKEN || '',
  baseUrl: env.DRIME_BASE_URL || 'https://app.drime.cloud/api/v1',
  papersFolderId: Number(env.DRIME_PAPERS_FOLDER_ID || 841342462),
  papersFolderHash: env.DRIME_PAPERS_FOLDER_HASH || 'ODQxMzQyNDYyfA',
  workspaceId: Number(env.DRIME_WORKSPACE_ID || 0),
};

module.exports = { drime };
