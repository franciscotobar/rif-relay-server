// TODO: convert to 'commander' format
import fs from 'fs';
import Web3 from 'web3';
import { HttpServer } from '../HttpServer';
import { RelayServer } from '../RelayServer';
import { KeyManager } from '../KeyManager';
import { TxStoreManager, TXSTORE_FILENAME } from '../TxStoreManager';
import { ContractInteractor } from '@rsksmart/rif-relay-common';
import { configure } from '@rsksmart/rif-relay-client';
import {
    parseServerConfig,
    resolveServerConfig,
    ServerDependencies,
    ServerConfigParams
} from '../ServerConfigParams';
import log from 'loglevel';

function error(err: string): void {
    console.error(err);
    process.exit(1);
}

async function run(): Promise<void> {
    let config: ServerConfigParams;
    let web3provider;
    let trustedVerifiers: string[] = [];
    console.log('Starting Enveloping Relay Server process...\n');
    try {
        const conf = await parseServerConfig(
            process.argv.slice(2),
            process.env
        );
        console.log(conf);
        if (conf.rskNodeUrl == null) {
            error('missing rskNodeUrl');
        }
        if (
            conf.trustedVerifiers !== undefined &&
            conf.trustedVerifiers != null &&
            conf.trustedVerifiers !== ''
        ) {
            trustedVerifiers = JSON.parse(conf.trustedVerifiers);
        }

        web3provider = new Web3.providers.HttpProvider(conf.rskNodeUrl);
        log.debug('runServer() - web3Provider done');
        config = (await resolveServerConfig(
            conf,
            web3provider
        )) as ServerConfigParams;
        log.debug('runServer() - config done');
        if (trustedVerifiers.length > 0) {
            config.trustedVerifiers = trustedVerifiers;
        }
    } catch (e) {
        if (e instanceof Error) {
            error(e.message);
        } else {
            console.error(e);
        }
    }
    const { devMode, workdir } = config;
    if (devMode) {
        if (fs.existsSync(`${workdir}/${TXSTORE_FILENAME}`)) {
            fs.unlinkSync(`${workdir}/${TXSTORE_FILENAME}`);
        }
    }

    const managerKeyManager = new KeyManager(1, workdir + '/manager');
    const workersKeyManager = new KeyManager(1, workdir + '/workers');
    log.debug('runServer() - manager and workers configured');
    const txStoreManager = new TxStoreManager({ workdir });
    const contractInteractor = new ContractInteractor(
        web3provider,
        configure({
            relayHubAddress: config.relayHubAddress,
            deployVerifierAddress: config.deployVerifierAddress,
            relayVerifierAddress: config.relayVerifierAddress
        })
    );
    await contractInteractor.init();
    log.debug('runServer() - contract interactor initilized');

    const dependencies: ServerDependencies = {
        txStoreManager,
        managerKeyManager,
        workersKeyManager,
        contractInteractor
    };

    const relayServer = new RelayServer(config, dependencies);
    await relayServer.init();
    log.debug('runServer() - Relay Server initialized');
    const httpServer = new HttpServer(config.port, relayServer);
    httpServer.start();
    log.debug('runServer() - Relay Server started');
}

run()
    .then(() => {
        log.debug('runServer() - Relay Server running');
    })
    .catch((error) => {
        log.error('runServer() - Error running server', error);
    });
