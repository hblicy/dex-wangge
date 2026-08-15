import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
import {
  createPermitParams,
  ExchangeClient,
  encodeCancelAll,
  encodeCancelOrder,
  encodeOrder,
} from 'risex-client';

const ABI_CODER = AbiCoder.defaultAbiCoder();
const UPDATE_LEVERAGE_ACTION_HASH = keccak256(toUtf8Bytes('RISE_PERPS_UPDATE_LEVERAGE_V1'));

export class RisexMainnetClient extends ExchangeClient {
  async createPermit(hash, nonce) {
    this.assertInit();
    const current = nonce ?? await this.getNonceState();
    const nonceAnchor = Number(current?.nonce_anchor);
    const nonceBitmapIndex = Number(current?.current_bitmap_index);
    if (!Number.isSafeInteger(nonceAnchor) || nonceAnchor < 0 || nonceAnchor >= (2 ** 48) - 1) {
      throw new Error('RISEx 主网 nonce_anchor 非法。');
    }
    if (!Number.isInteger(nonceBitmapIndex) || nonceBitmapIndex < 0 || nonceBitmapIndex > 255) {
      throw new Error('RISEx 主网 current_bitmap_index 非法。');
    }
    return createPermitParams(
      hash,
      this.signerWallet,
      this.account,
      this.target,
      this.domain,
      {
        nonce_anchor: nonceAnchor + 1,
        current_bitmap_index: nonceBitmapIndex >= 208 ? 0 : nonceBitmapIndex,
      },
      undefined,
      this.isErc1271,
    );
  }

  async placeOrder(orderParams) {
    const permitParams = await this.createPermit(
      encodeOrder(orderParams, this.isErc1271),
      orderParams.nonce,
    );
    return this.info.http.post('/v1/orders/place', {
      market_id: orderParams.market_id,
      side: orderParams.side,
      order_type: orderParams.order_type,
      price_ticks: orderParams.price_ticks,
      size_steps: orderParams.size_steps,
      time_in_force: orderParams.time_in_force,
      post_only: orderParams.post_only,
      reduce_only: orderParams.reduce_only,
      stp_mode: orderParams.stp_mode,
      ttl_units: orderParams.ttl_units,
      client_order_id: orderParams.client_order_id ?? '0',
      builder_id: orderParams.builder_id ?? 0,
      permit_params: permitParams,
    });
  }

  async cancelOrder(params) {
    let restingOrderId = params.resting_order_id;
    if (restingOrderId == null) {
      const openOrders = await this.info.getOpenOrders(this.account, params.market_id);
      const match = openOrders.find((order) => order.order_id === params.order_id);
      if (match?.resting_order_id == null) {
        throw new Error(`RISEx 无法获取订单 ${params.order_id} 的 resting_order_id。`);
      }
      restingOrderId = match.resting_order_id;
    }
    const permitParams = await this.createPermit(
      encodeCancelOrder({ ...params, resting_order_id: restingOrderId }),
      params.nonce,
    );
    return this.info.http.post('/v1/orders/cancel', {
      market_id: params.market_id,
      order_id: params.order_id,
      permit_params: permitParams,
    });
  }

  async cancelAllOrders(marketId = 0, nonce) {
    const permitParams = await this.createPermit(encodeCancelAll(marketId), nonce);
    return this.info.http.post('/v1/orders/cancel-all', {
      market_id: marketId,
      permit_params: permitParams,
    });
  }

  async updateLeverage(marketId, leverage, nonce) {
    const actionHash = keccak256(ABI_CODER.encode(
      ['bytes32', 'uint16', 'uint8'],
      [UPDATE_LEVERAGE_ACTION_HASH, marketId, leverage],
    ));
    const permitParams = await this.createPermit(actionHash, nonce);
    return this.info.http.post('/v1/account/leverage', {
      market_id: marketId,
      leverage: String(leverage),
      permit_params: permitParams,
    });
  }
}
