import { useMemo, useState } from 'react';
import { AlertCircle, CreditCard, PackageCheck, RotateCcw, Search, ShoppingBag } from 'lucide-react';

const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
const label = (value) => (value || 'unknown').replaceAll('_', ' ');
const date = (value) => value ? new Date(value).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '—';

export default function OrdersDesk({ orders, onStatus, onRefund, paymentsEnabled }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [restock, setRestock] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const selected = orders.find((order) => order.id === selectedId) || orders[0];
  const visible = useMemo(() => orders.filter((order) => {
    const matchesStatus = filter === 'all' || (filter === 'attention' ? order.status === 'paid_stock_review' || order.refund?.status === 'failed' : order.status === filter);
    const needle = `${order.id} ${order.customerEmail || ''} ${(order.items || []).map((item) => item.name).join(' ')}`.toLowerCase();
    return matchesStatus && needle.includes(query.trim().toLowerCase());
  }), [orders, filter, query]);

  async function refund() {
    if (!selected || !paymentsEnabled || !['paid', 'paid_stock_review'].includes(selected.status) || refunding) return;
    const shouldRestock = restock && selected.status === 'paid';
    const restockWarning = shouldRestock ? '\n\nYou confirmed that these items have physically returned to stock.' : '\n\nInventory will not be restocked.';
    if (!window.confirm(`Issue a FULL Stripe refund for order #${selected.id.slice(0, 8).toUpperCase()} (${money(selected.totalAmount)})?${restockWarning}\n\nThis action cannot be undone.`)) return;
    setRefunding(true);
    try { await onRefund(selected.id, shouldRestock); }
    finally { setRefunding(false); }
  }

  return <>
    <div className="admin-page-title"><div><div className="admin-accent"/><h1>Orders & fulfillment</h1><p>Track verified payments, salon pickup, returns, and Stripe refunds in one workspace.</p></div></div>
    <div className="admin-metrics three">
      <div className="admin-metric"><span className="admin-metric-icon"><ShoppingBag size={22}/></span><div><small>Total orders</small><strong>{orders.length}</strong></div></div>
      <div className="admin-metric"><span className="admin-metric-icon"><PackageCheck size={22}/></span><div><small>Awaiting pickup</small><strong>{orders.filter((o) => o.status === 'paid' && o.fulfillmentStatus !== 'fulfilled').length}</strong></div></div>
      <div className="admin-metric"><span className="admin-metric-icon amber"><AlertCircle size={22}/></span><div><small>Needs review</small><strong>{orders.filter((o) => o.status === 'paid_stock_review' || o.refund?.status === 'failed').length}</strong></div></div>
    </div>
    <div className="admin-orders-layout">
      <div className="admin-editor-main">
        <div className="admin-filters"><label className="admin-search"><Search size={19}/><input aria-label="Search orders" placeholder="Search order, customer, or product" value={query} onChange={(event) => setQuery(event.target.value)}/></label>
          <select aria-label="Filter payment status" value={filter} onChange={(event) => setFilter(event.target.value)}>{[['all', 'All orders'], ['pending', 'Awaiting payment'], ['paid', 'Paid'], ['refunded', 'Refunded'], ['expired', 'Expired'], ['attention', 'Needs attention']].map(([value, title]) => <option value={value} key={value}>{title}</option>)}</select></div>
        <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Payment</th><th>Fulfillment</th><th/></tr></thead><tbody>{visible.map((order) => <tr key={order.id} className={selected?.id === order.id ? 'selected-row' : ''}><td><strong>#{order.id.slice(0, 8).toUpperCase()}</strong><small className="admin-table-note">{date(order.createdAt)}</small></td><td>{order.customerEmail || 'Guest checkout'}</td><td>{money(order.totalAmount)}</td><td><span className={`admin-pill ${order.status === 'paid' ? 'good' : 'warning'}`}>{label(order.status)}</span></td><td>{label(order.fulfillmentStatus)}</td><td><button className="admin-outline" onClick={() => { setSelectedId(order.id); setRestock(false); }}>Review</button></td></tr>)}</tbody></table>{visible.length === 0 && <p className="admin-muted admin-orders-empty">No orders match this filter.</p>}</div>
      </div>
      <aside className="admin-editor-panel admin-order-detail">
        {selected ? <>
          <span className="admin-eyebrow">ORDER DETAILS</span><h2>#{selected.id.slice(0, 8).toUpperCase()}</h2>
          <p className="admin-muted">Created {date(selected.createdAt)} · {selected.fulfillmentMethod === 'pickup' ? 'Salon pickup' : 'Retail order'}</p>
          <div className="admin-order-detail-line"><span>Customer</span><strong>{selected.customerEmail || 'Guest checkout'}</strong></div>
          <div className="admin-order-detail-line"><span>Payment</span><strong>{label(selected.status)}</strong></div>
          <div className="admin-order-detail-line"><span>Stock</span><strong>{label(selected.stockState)}</strong></div>
          {selected.refund?.status && <div className="admin-order-detail-line"><span>Stripe refund</span><strong>{label(selected.refund.status)}</strong></div>}
          <h3>Order items</h3>
          {(selected.items || []).map((item) => <div className="admin-order-item" key={item.productId}><span>{item.quantity} × {item.name}<small>{item.sku || 'No SKU'}</small></span><strong>{money(item.unitPrice * item.quantity)}</strong></div>)}
          <div className="admin-order-total"><span>Order total</span><strong>{money(selected.totalAmount)}</strong></div>
          <h3>Pickup status</h3>
          <select className="admin-order-select" value={selected.fulfillmentStatus || 'unfulfilled'} disabled={selected.status !== 'paid'} onChange={(event) => onStatus(selected.id, event.target.value)} aria-label="Change fulfillment status">
            {['unfulfilled', 'processing', 'fulfilled'].map((status) => <option key={status} value={status}>{label(status)}</option>)}
          </select>
          {selected.status === 'paid_stock_review' && <p className="admin-order-warning">Payment was confirmed after this order's stock reservation was released. Resolve stock and customer compensation manually; do not hand out products automatically.</p>}
          <div className="admin-order-refund"><h3><RotateCcw size={17}/> Full refund</h3><p>Use Stripe to refund the full payment. Restock only after returned items are physically in the salon.</p>
            <label className="admin-order-restock"><input type="checkbox" checked={restock && selected.status !== 'paid_stock_review'} disabled={Boolean(selected.refundRequestedAt) || selected.status === 'paid_stock_review'} onChange={(event) => setRestock(event.target.checked)}/> Return all units to inventory after successful refund</label>
            {selected.refundRequestedAt && <p className="admin-muted">Existing request: {selected.refundRestock ? 'restock on success' : 'do not restock'}. Subsequent retries preserve that decision.</p>}
            <button className="admin-outline admin-refund-button" onClick={refund} disabled={!paymentsEnabled || !['paid', 'paid_stock_review'].includes(selected.status) || refunding || Boolean(selected.refund?.status)}><CreditCard size={16}/>{refunding ? 'Contacting Stripe…' : selected.status === 'refunded' ? 'Refund complete' : selected.refund?.status === 'pending' ? 'Awaiting Stripe confirmation' : ['failed', 'canceled'].includes(selected.refund?.status) ? 'Reconcile in Stripe' : 'Issue full refund'}</button>
          </div>
        </> : <p className="admin-muted">No retail orders have been placed.</p>}
      </aside>
    </div>
  </>;
}
