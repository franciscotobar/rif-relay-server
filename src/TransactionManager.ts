// @ts-ignore
import EthVal from 'ethval';
import chalk from 'chalk';
import log from 'loglevel';
import { Mutex } from 'async-mutex';
import {
    PrefixedHexString,
    Transaction,
    TransactionOptions
} from 'ethereumjs-tx';
import { ContractInteractor } from '@rsksmart/rif-relay-common';
import { TxStoreManager } from './TxStoreManager';
import { KeyManager } from './KeyManager';
import { ServerDependencies, ServerConfigParams } from './ServerConfigParams';
import {
    createStoredTransaction,
    ServerAction,
    StoredTransaction,
    StoredTransactionMetadata
} from './StoredTransaction';

export interface SignedTransactionDetails {
    transactionHash: PrefixedHexString;
    signedTx: PrefixedHexString;
}

export interface SendTransactionDetails {
    signer: string;
    serverAction: ServerAction;
    method?: any;
    destination: string;
    value?: string;
    gasLimit: number;
    gasPrice?: string;
    creationBlockNumber: number;
}

export class TransactionManager {
    nonceMutex = new Mutex();
    managerKeyManager: KeyManager;
    workersKeyManager: KeyManager;
    contractInteractor: ContractInteractor;
    nonces: Record<string, number> = {};
    txStoreManager: TxStoreManager;
    config: ServerConfigParams;

    rawTxOptions!: TransactionOptions;

    constructor(dependencies: ServerDependencies, config: ServerConfigParams) {
        this.contractInteractor = dependencies.contractInteractor;
        this.txStoreManager = dependencies.txStoreManager;
        this.workersKeyManager = dependencies.workersKeyManager;
        this.managerKeyManager = dependencies.managerKeyManager;
        this.config = config;
        this._initNonces();
    }

    _initNonces(): void {
        // todo: initialize nonces for all signers (currently one manager, one worker)
        this.nonces[this.managerKeyManager.getAddress(0)] = 0;
        this.nonces[this.workersKeyManager.getAddress(0)] = 0;
    }

    async _init(): Promise<void> {
        this.rawTxOptions = this.contractInteractor.getRawTxOptions();
        if (this.rawTxOptions == null) {
            throw new Error(
                '_init failed for TransactionManager, was ContractInteractor properly initialized?'
            );
        }
    }

    printBoostedTransactionLog(
        txHash: string,
        creationBlockNumber: number,
        gasPrice: number,
        isMaxGasPriceReached: boolean
    ): void {
        const gasPriceHumanReadableOld: string = new EthVal(gasPrice)
            .toGwei()
            .toFixed(4);
        log.info(`Boosting stale transaction:
hash         | ${txHash}
gasPrice     | ${gasPrice} (${gasPriceHumanReadableOld} gwei) ${
            isMaxGasPriceReached ? chalk.red('k256') : ''
        }
created at   | block #${creationBlockNumber}
`);
    }

    printSendTransactionLog(transaction: Transaction, from: string): void {
        const valueString =
            transaction.value.length === 0
                ? '0'
                : parseInt('0x' + transaction.value.toString('hex')).toString();
        const nonceString =
            transaction.nonce.length === 0
                ? '0'
                : parseInt('0x' + transaction.nonce.toString('hex'));
        const gasPriceString = parseInt(
            '0x' + transaction.gasPrice.toString('hex')
        );

        const valueHumanReadable: string = new EthVal(valueString)
            .toEth()
            .toFixed(4);
        const gasPriceHumanReadable: string = new EthVal(gasPriceString)
            .toGwei()
            .toFixed(4);
        log.info(`Broadcasting transaction:
hash         | 0x${transaction.hash().toString('hex')}
from         | ${from}
to           | 0x${transaction.to.toString('hex')}
value        | ${valueString} (${valueHumanReadable} RBTC)
nonce        | ${nonceString}
gasPrice     | ${gasPriceString} (${gasPriceHumanReadable} gwei)
gasLimit     | ${parseInt('0x' + transaction.gasLimit.toString('hex'))}
data         | 0x${transaction.data.toString('hex')}
`);
    }

    async attemptEstimateGas(
        methodName: string,
        method: any,
        from: string
    ): Promise<number> {
        try {
            const estimateGas = await method.estimateGas({ from });
            return Math.round(
                parseInt(estimateGas) * this.config.estimateGasFactor
            );
        } catch (e) {
            if (e instanceof Error) {
                log.error(
                    `Failed to estimate gas for method ${methodName}\n. Using default ${this.config.defaultGasLimit}`,
                    e.message
                );
            } else {
                console.error(e);
            }
        }
        return this.config.defaultGasLimit;
    }

    async sendTransaction({
        signer,
        method,
        destination,
        value = '0x',
        gasLimit,
        gasPrice,
        creationBlockNumber,
        serverAction
    }: SendTransactionDetails): Promise<SignedTransactionDetails> {
        const encodedCall = method?.encodeABI() ?? '0x';
        const _gasPrice = parseInt(
            gasPrice ?? (await this.contractInteractor.getGasPrice())
        );
        const releaseMutex = await this.nonceMutex.acquire();
        let signedTx;
        let storedTx: StoredTransaction;
        try {
            const nonce = await this.pollNonce(signer);
            const txToSign = new Transaction(
                {
                    to: destination,
                    value: value,
                    gasLimit,
                    gasPrice: _gasPrice,
                    data: Buffer.from(encodedCall.slice(2), 'hex'),
                    nonce
                },
                this.rawTxOptions
            );
            // TODO omg! do not do this!
            const keyManager = this.managerKeyManager.isSigner(signer)
                ? this.managerKeyManager
                : this.workersKeyManager;
            signedTx = keyManager.signTransaction(signer, txToSign);
            const metadata: StoredTransactionMetadata = {
                from: signer,
                attempts: 1,
                serverAction,
                creationBlockNumber
            };
            storedTx = createStoredTransaction(txToSign, metadata);
            this.nonces[signer]++;
            await this.txStoreManager.putTx(storedTx, false);
            this.printSendTransactionLog(txToSign, signer);
        } finally {
            releaseMutex();
        }
        const transactionHash =
            await this.contractInteractor.broadcastTransaction(signedTx);
        if (transactionHash.toLowerCase() !== storedTx.txId.toLowerCase()) {
            throw new Error(
                `txhash mismatch: from receipt: ${transactionHash} from txstore:${storedTx.txId}`
            );
        }
        return {
            transactionHash,
            signedTx
        };
    }

    async updateTransactionWithMinedBlock(
        tx: StoredTransaction,
        minedBlockNumber: number
    ): Promise<void> {
        const storedTx: StoredTransaction = Object.assign({}, tx, {
            minedBlockNumber
        });
        await this.txStoreManager.putTx(storedTx, true);
    }

    async updateTransactionWithAttempt(
        txToSign: Transaction,
        tx: StoredTransaction,
        currentBlock: number
    ): Promise<StoredTransaction> {
        const metadata: StoredTransactionMetadata = {
            attempts: tx.attempts + 1,
            boostBlockNumber: currentBlock,
            from: tx.from,
            serverAction: tx.serverAction,
            creationBlockNumber: tx.creationBlockNumber,
            minedBlockNumber: tx.minedBlockNumber
        };
        const storedTx = createStoredTransaction(txToSign, metadata);
        await this.txStoreManager.putTx(storedTx, true);
        return storedTx;
    }

    async resendTransaction(
        tx: StoredTransaction,
        currentBlock: number,
        newGasPrice: number,
        isMaxGasPriceReached: boolean
    ): Promise<SignedTransactionDetails> {
        // Resend transaction with exactly the same values except for gas price
        const txToSign = new Transaction(
            {
                to: tx.to,
                gasLimit: tx.gas,
                gasPrice: newGasPrice,
                data: tx.data,
                nonce: tx.nonce
            },
            this.rawTxOptions
        );

        const keyManager = this.managerKeyManager.isSigner(tx.from)
            ? this.managerKeyManager
            : this.workersKeyManager;
        const signedTx = keyManager.signTransaction(tx.from, txToSign);
        const storedTx = await this.updateTransactionWithAttempt(
            txToSign,
            tx,
            currentBlock
        );

        this.printBoostedTransactionLog(
            tx.txId,
            tx.creationBlockNumber,
            tx.gasPrice,
            isMaxGasPriceReached
        );
        this.printSendTransactionLog(txToSign, tx.from);
        const currentNonce = await this.contractInteractor.getTransactionCount(
            tx.from
        );
        log.debug(`Current account nonce for ${tx.from} is ${currentNonce}`);
        const transactionHash =
            await this.contractInteractor.broadcastTransaction(signedTx);
        if (transactionHash.toLowerCase() !== storedTx.txId.toLowerCase()) {
            throw new Error(
                `txhash mismatch: from receipt: ${transactionHash} from txstore:${storedTx.txId}`
            );
        }
        return {
            transactionHash,
            signedTx
        };
    }

    _resolveNewGasPrice(oldGasPrice: number): {
        newGasPrice: number;
        isMaxGasPriceReached: boolean;
    } {
        let isMaxGasPriceReached = false;
        let newGasPrice = oldGasPrice * this.config.retryGasPriceFactor;
        // TODO: use BN for RBTC values
        // Sanity check to ensure we are not burning all our balance in gas fees
        if (newGasPrice > parseInt(this.config.maxGasPrice)) {
            isMaxGasPriceReached = true;
            newGasPrice = parseInt(this.config.maxGasPrice);
        }
        return { newGasPrice, isMaxGasPriceReached };
    }

    async pollNonce(signer: string): Promise<number> {
        const nonce = await this.contractInteractor.getTransactionCount(
            signer,
            'pending'
        );
        if (nonce > this.nonces[signer]) {
            log.warn(
                'NONCE FIX for signer=',
                signer,
                ': nonce=',
                nonce,
                this.nonces[signer]
            );
            this.nonces[signer] = nonce;
        }
        return this.nonces[signer];
    }

    async removeConfirmedTransactions(blockNumber: number): Promise<void> {
        // Load unconfirmed transactions from store, and bail if there are none
        const sortedTxs = await this.txStoreManager.getAll();
        if (sortedTxs.length === 0) {
            return;
        }
        log.debug(
            `Total of ${sortedTxs.length} transactions are not confirmed yet, checking...`
        );
        // Get nonce at confirmationsNeeded blocks ago
        for (const transaction of sortedTxs) {
            const shouldRecheck =
                transaction.minedBlockNumber == null ||
                blockNumber - transaction.minedBlockNumber >=
                    this.config.confirmationsNeeded;
            if (shouldRecheck) {
                const receipt = await this.contractInteractor.getTransaction(
                    transaction.txId
                );
                if (receipt == null) {
                    log.warn(
                        `warning: failed to fetch receipt for tx ${transaction.txId}`
                    );
                    continue;
                }
                if (receipt.blockNumber == null) {
                    log.warn(
                        `warning: null block number in receipt for ${transaction.txId}`
                    );
                    continue;
                }
                const confirmations = blockNumber - receipt.blockNumber;
                if (receipt.blockNumber !== transaction.minedBlockNumber) {
                    if (transaction.minedBlockNumber != null) {
                        log.warn(
                            `transaction ${transaction.txId} was moved between blocks`
                        );
                    }
                    if (confirmations < this.config.confirmationsNeeded) {
                        log.debug(
                            `Tx ${transaction.txId} was mined but only has ${confirmations} confirmations`
                        );
                        await this.updateTransactionWithMinedBlock(
                            transaction,
                            receipt.blockNumber
                        );
                        continue;
                    }
                }
                // Clear out all confirmed transactions (ie txs with nonce less than the account nonce at confirmationsNeeded blocks ago)
                log.debug(
                    `removing tx number ${receipt.nonce} sent by ${receipt.from} with ${confirmations} confirmations`
                );
                await this.txStoreManager.removeTxsUntilNonce(
                    receipt.from,
                    receipt.nonce
                );
            }
        }
    }

    /**
     * This methods uses the oldest pending transaction for reference. If it was not mined in a reasonable time,
     * it is boosted all consequent transactions with gas price lower then that are boosted as well.
     */
    async boostUnderpricedPendingTransactionsForSigner(
        signer: string,
        currentBlockHeight: number
    ): Promise<Map<PrefixedHexString, SignedTransactionDetails>> {
        const boostedTransactions = new Map<
            PrefixedHexString,
            SignedTransactionDetails
        >();

        // Load unconfirmed transactions from store again
        const sortedTxs = await this.txStoreManager.getAllBySigner(signer);
        if (sortedTxs.length === 0) {
            return boostedTransactions;
        }
        // Check if the tx was mined by comparing its nonce against the latest one
        const nonce = await this.contractInteractor.getTransactionCount(signer);
        const oldestPendingTx = sortedTxs[0];
        if (oldestPendingTx.nonce < nonce) {
            log.debug(
                `${signer} : transaction is mined, awaiting confirmations. Account nonce: ${nonce}, oldest transaction: nonce: ${oldestPendingTx.nonce} txId: ${oldestPendingTx.txId}`
            );
            return boostedTransactions;
        }

        const lastSentAtBlockHeight =
            oldestPendingTx.boostBlockNumber ??
            oldestPendingTx.creationBlockNumber;
        // If the tx is still pending, check how long ago we sent it, and resend it if needed
        if (
            currentBlockHeight - lastSentAtBlockHeight <
            this.config.pendingTransactionTimeoutBlocks
        ) {
            log.debug(
                `${signer} : awaiting transaction with ID: ${oldestPendingTx.txId} to be mined. creationBlockNumber: ${oldestPendingTx.creationBlockNumber} nonce: ${nonce}`
            );
            return boostedTransactions;
        }

        // Calculate new gas price as a % increase over the previous one
        const { newGasPrice, isMaxGasPriceReached } = this._resolveNewGasPrice(
            oldestPendingTx.gasPrice
        );
        const underpricedTransactions = sortedTxs.filter(
            (it) => it.gasPrice < newGasPrice
        );
        for (const transaction of underpricedTransactions) {
            const boostedTransactionDetails = await this.resendTransaction(
                transaction,
                currentBlockHeight,
                newGasPrice,
                isMaxGasPriceReached
            );
            boostedTransactions.set(
                transaction.txId,
                boostedTransactionDetails
            );
            log.debug(
                `Replaced transaction: nonce: ${transaction.nonce} sender: ${signer} | ${transaction.txId} => ${boostedTransactionDetails.transactionHash}`
            );
            if (transaction.attempts > 2) {
                log.debug(
                    `resend ${signer}: Sent tx ${transaction.attempts} times already`
                );
            }
        }
        return boostedTransactions;
    }
}
