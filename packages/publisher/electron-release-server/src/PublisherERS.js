import PublisherBase from '@electron-forge/publisher-base';
import { asyncOra } from '@electron-forge/async-ora';

import debug from 'debug';
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs-extra';
import path from 'path';

const d = debug('electron-forge:publish:ers');

export const ersPlatform = (platform, arch) => {
  switch (platform) {
    case 'darwin':
      return 'osx_64';
    case 'linux':
      return arch === 'ia32' ? 'linux_32' : 'linux_64';
    case 'win32':
      return arch === 'ia32' ? 'windows_32' : 'windows_64';
    default:
      return platform;
  }
};

export default class PublisherERS extends PublisherBase {
  name = 'electron-release-server';

  async publish({ makeResults, packageJSON, platform, arch }) {
    const { config } = this;

    const artifacts = makeResults.reduce((flat, makeResult) => {
      flat.push(...makeResult.artifacts);
      return flat;
    }, []);

    if (!(config.baseUrl && config.username && config.password)) {
      throw 'In order to publish to ERS you must set the "electronReleaseServer.baseUrl", "electronReleaseServer.username" and "electronReleaseServer.password" properties in your forge config. See the docs for more info'; // eslint-disable-line
    }

    d('attempting to authenticate to ERS');

    const api = apiPath => `${config.baseUrl}/${apiPath}`;

    const { token } = await (await fetch(api('api/auth/login'), {
      method: 'POST',
      body: JSON.stringify({
        username: config.username,
        password: config.password,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    })).json();

    const authFetch = (apiPath, options) => fetch(api(apiPath), Object.assign({}, options || {}, {
      headers: Object.assign({}, (options || {}).headers, { Authorization: `Bearer ${token}` }),
    }));

    const versions = await (await authFetch('api/version')).json();
    const existingVersion = versions.find(version => version.name === packageJSON.version);

    let channel = 'stable';
    if (config.channel) {
      channel = config.channel;
    } else if (packageJSON.version.includes('beta')) {
      channel = 'beta';
    } else if (packageJSON.version.includes('alpha')) {
      channel = 'alpha';
    }

    if (!existingVersion) {
      await authFetch('api/version', {
        method: 'POST',
        body: JSON.stringify({
          channel: {
            name: channel,
          },
          name: packageJSON.version,
          notes: '',
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    let uploaded = 0;
    await asyncOra(`Uploading Artifacts ${uploaded}/${artifacts.length}`, async (uploadSpinner) => {
      const updateSpinner = () => {
        uploadSpinner.text = `Uploading Artifacts ${uploaded}/${artifacts.length}`; // eslint-disable-line no-param-reassign
      };

      await Promise.all(artifacts.map(artifactPath =>
        new Promise(async (resolve, reject) => {
          if (existingVersion) {
            const existingAsset = existingVersion.assets.find(asset => asset.name === path.basename(artifactPath));
            if (existingAsset) {
              d('asset at path:', artifactPath, 'already exists on server');
              uploaded += 1;
              updateSpinner();
              return;
            }
          }
          try {
            d('attempting to upload asset:', artifactPath);
            const artifactForm = new FormData();
            artifactForm.append('token', token);
            artifactForm.append('version', packageJSON.version);
            artifactForm.append('platform', ersPlatform(platform, arch));
            artifactForm.append('file', fs.createReadStream(artifactPath));
            await authFetch('api/asset', {
              method: 'POST',
              body: artifactForm,
              headers: artifactForm.getHeaders(),
            });
            d('upload successful for asset:', artifactPath);
            uploaded += 1;
            updateSpinner();
            resolve();
          } catch (err) {
            reject(err);
          }
        })
      ));
    });
  }
}
