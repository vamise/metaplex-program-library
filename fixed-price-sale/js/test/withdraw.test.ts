import BN from 'bn.js';
import test from 'tape';
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { assertConfirmedTransaction, defaultSendOptions } from '@metaplex-foundation/amman';
import { Edition, EditionMarker, Metadata } from '@metaplex-foundation/mpl-token-metadata';
import { findPayoutTicketAddress, findTradeHistoryAddress } from '../src/utils';
import { closeMarket, createBuyTransaction, createWithdrawTransaction } from './transactions';
import { killStuckProcess, logDebug, sleep } from './utils';
import {
  createPrerequisites,
  createStore,
  initSellingResource,
  createMarket,
  mintNFT,
  mintTokenToAccount,
} from './actions';

killStuckProcess();

test('withdraw: success', async (t) => {
  const { payer, connection, transactionHandler } = await createPrerequisites();

  const store = await createStore({
    test: t,
    transactionHandler,
    payer,
    connection,
    params: {
      name: 'Store',
      description: 'Description',
    },
  });

  const { sellingResource, vault, vaultOwner, vaultOwnerBump, resourceMint } =
    await initSellingResource({
      test: t,
      transactionHandler,
      payer,
      connection,
      store: store.publicKey,
      maxSupply: 100,
    });

  const { mint: treasuryMint, tokenAccount: userTokenAcc } = await mintNFT({
    transactionHandler,
    payer,
    connection,
  });

  const startDate = Math.round(Date.now() / 1000) + 1;
  const params = {
    name: 'Market',
    description: '',
    startDate,
    endDate: null,
    mutable: true,
    price: 1,
    piecesInOneWallet: 1,
  };

  const { market, treasuryHolder, treasuryOwnerBump, treasuryOwner } = await createMarket({
    test: t,
    transactionHandler,
    payer,
    connection,
    store: store.publicKey,
    sellingResource: sellingResource.publicKey,
    treasuryMint: treasuryMint.publicKey,
    params,
  });

  await sleep(3000);

  const [tradeHistory, tradeHistoryBump] = await findTradeHistoryAddress(
    payer.publicKey,
    market.publicKey,
  );

  const { mint: newMint } = await mintTokenToAccount({
    connection,
    payer: payer.publicKey,
    transactionHandler,
  });

  logDebug('new mint', newMint.publicKey.toBase58());

  const newMintEdition = await Edition.getPDA(newMint.publicKey);
  const newMintMetadata = await Metadata.getPDA(newMint.publicKey);

  const resourceMintMasterEdition = await Edition.getPDA(resourceMint.publicKey);
  const resourceMintMetadata = await Metadata.getPDA(resourceMint.publicKey);
  const resourceMintEditionMarker = await EditionMarker.getPDA(resourceMint.publicKey, new BN(1));

  await sleep(1000);

  const { tx: buyTx } = await createBuyTransaction({
    connection,
    buyer: payer.publicKey,
    userTokenAccount: userTokenAcc.publicKey,
    resourceMintMetadata,
    resourceMintEditionMarker,
    resourceMintMasterEdition,
    sellingResource: sellingResource.publicKey,
    market: market.publicKey,
    marketTreasuryHolder: treasuryHolder.publicKey,
    vaultOwner,
    tradeHistory,
    tradeHistoryBump,
    vault: vault.publicKey,
    vaultOwnerBump,
    newMint: newMint.publicKey,
    newMintEdition,
    newMintMetadata,
  });

  const buyRes = await transactionHandler.sendAndConfirmTransaction(
    buyTx,
    [payer],
    defaultSendOptions,
  );

  logDebug('buy:: successful purchase');
  assertConfirmedTransaction(t, buyRes.txConfirmed);

  await sleep(3000);

  const marketTx = await closeMarket({
    transactionHandler,
    payer,
    connection,
    market,
  });

  const marketRes = await transactionHandler.sendAndConfirmTransaction(
    marketTx,
    [payer],
    defaultSendOptions,
  );

  logDebug(`market: ${market.publicKey}`);
  assertConfirmedTransaction(t, marketRes.txConfirmed);

  const [payoutTicket, payoutTicketBump] = await findPayoutTicketAddress(
    market.publicKey,
    payer.publicKey,
  );

  const destination = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    treasuryMint.publicKey,
    payer.publicKey,
  );

  const metadata = await Metadata.getPDA(resourceMint.publicKey);

  const withdrawTx = await createWithdrawTransaction({
    connection,
    payer,
    market: market.publicKey,
    sellingResource: sellingResource.publicKey,
    metadata,
    treasuryHolder: treasuryHolder.publicKey,
    treasuryMint: treasuryMint.publicKey,
    destination,
    payoutTicket,
    payoutTicketBump,
    treasuryOwnerBump,
    treasuryOwner,
  });

  const withdrawRes = await transactionHandler.sendAndConfirmTransaction(
    withdrawTx,
    [payer],
    defaultSendOptions,
  );

  assertConfirmedTransaction(t, withdrawRes.txConfirmed);

  const payoutTicketData = await connection.getAccountInfo(payoutTicket);
  t.assert(payoutTicketData.owner);
});
