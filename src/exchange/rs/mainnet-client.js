import {
  ExchangeClient,
  encodeCancelAll,
  encodeCancelOrder,
  encodeLeverage,
  encodeOrder,
} from 'risex-client';

export class RisexMainnetClient extends ExchangeClient {
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
    const permitParams = await this.createPermit(encodeLeverage(marketId, leverage), nonce);
    return this.info.http.post('/v1/account/leverage', {
      market_id: marketId,
      leverage: String(leverage),
      permit_params: permitParams,
    });
  }
}
