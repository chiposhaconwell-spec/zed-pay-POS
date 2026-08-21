import React, { useState, useEffect } from 'react';
import { Play, Terminal, Database, Trash2, Clock, CheckCircle2, AlertCircle, HelpCircle, Code, Copy, Check } from 'lucide-react';
import { runSql, getSqlLogs, clearSqlLogs, subscribeToSqlLogs } from '../db';
import { SqlLogEntry } from '../types';

interface SqlMonitorProps {
  isSplitView?: boolean;
}

const TEMPLATE_QUERIES = [
  {
    label: 'Postgres Double-Entry (ZMW)',
    sql: `-- 1. Create the base transaction record in POS Journal
INSERT INTO transactions (id, idempotency_key, pos_terminal_id, channel, provider_reference, amount, fee_amount, status, narration, created_at)
VALUES ('tx-8815', 'unique-uuid-from-pos-lusaka', 'POS-LUSAKA-01', 'MTN_MOMO', 'MTN-REF-POS-81', 1000.00, 10.00, 'SUCCESS', 'Payment via MTN Kwacha MoMo', '2026-06-07T12:30:00Z');

-- 2. Debit the MTN Clearing Account (Asset increases by K1,000)
INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
VALUES ('le-pos-deb-8815', 'tx-8815', 'mtn-clearing-account-uuid', 'DEBIT', 1000.00, '2026-06-07T12:30:00Z');

-- 3. Credit the Merchant's Wallet (Liability to merchant increases by K990)
INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
VALUES ('le-pos-cre-merch-8815', 'tx-8815', 'merchant-wallet-account-uuid', 'CREDIT', 990.00, '2026-06-07T12:30:00Z');

-- 4. Credit your Platform Revenue Account (Revenue increases by K10)
INSERT INTO ledger_entries (id, transaction_id, account_id, type, amount, created_at)
VALUES ('le-pos-cre-fees-8815', 'tx-8815', 'platform-revenue-account-uuid', 'CREDIT', 10.00, '2026-06-07T12:30:00Z');

-- 5. Calculate live balances of accounts in ZMW
SELECT * FROM view_account_balances;`,
    desc: 'Execute your multi-statement PostgreSQL double-entry transaction record and calculate live trial balances in local Kwacha (ZMW)'
  },
  {
    label: 'Low Stocks Check',
    sql: 'SELECT id, name, sku, stock, price FROM products WHERE stock <= 5 ORDER BY stock ASC;',
    desc: 'List products currently at or below minimum buffer stock'
  },
  {
    label: 'Top Loyalty Customers',
    sql: 'SELECT name, phone, loyalPoints FROM customers WHERE loyalPoints > 50 ORDER BY loyalPoints DESC;',
    desc: 'List customer profiles sorted by royalty club point totals'
  },
  {
    label: 'Checkout Performance',
    sql: 'SELECT paymentMethod, COUNT(*) AS transactions, SUM(total) AS revenue, AVG(total) AS ticket_size FROM orders GROUP BY paymentMethod;',
    desc: 'Aggregate analytics by ledger method'
  },
  {
    label: 'Sales Item Matching',
    sql: 'SELECT o.id AS order_id, o.orderDate, p.name AS item_name, oi.quantity, oi.unitPrice, (oi.quantity * oi.unitPrice) AS subtotal FROM order_items oi JOIN products p ON oi.productId = p.id JOIN orders o ON oi.orderId = o.id ORDER BY o.orderDate DESC;',
    desc: 'A multi-table JOIN linking orders, items, and main product lists'
  },
  {
    label: 'Add New Custom Product',
    sql: "INSERT INTO products VALUES (10, 'Fresh Matcha Cookies', 'FOD-105', 'Desserts', 3.75, 1.00, 30, 'https://images.unsplash.com/photo-1558961309-dbdf000302f6?w=150');",
    desc: 'Insert custom stock into PRODUCTS table directly via statement'
  }
];

export default function SqlMonitor({ isSplitView = false }: SqlMonitorProps) {
  const [queryCode, setQueryCode] = useState('SELECT * FROM products ORDER BY stock ASC;');
  const [logs, setLogs] = useState<SqlLogEntry[]>([]);
  const [queryResult, setQueryResult] = useState<{ headers: string[]; rows: any[] } | null>(null);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [affectedCount, setAffectedCount] = useState<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  useEffect(() => {
    setLogs(getSqlLogs());
    const unsubscribe = subscribeToSqlLogs(() => {
      setLogs(getSqlLogs());
    });
    return unsubscribe;
  }, []);

  const handleRunQuery = (codeToRun?: string) => {
    const code = codeToRun || queryCode;
    if (!code.trim()) return;

    setSqlError(null);
    setQueryResult(null);
    setAffectedCount(null);

    // Identify category of operation for descriptive logs
    let opDesc = 'Console Scratchpad Query';
    const cleanSql = code.trim().toUpperCase();
    if (cleanSql.startsWith('SELECT')) opDesc = 'Manual SELECT Query';
    else if (cleanSql.startsWith('UPDATE')) opDesc = 'Manual Database Update';
    else if (cleanSql.startsWith('INSERT')) opDesc = 'Manual Row Insertion';
    else if (cleanSql.startsWith('DELETE')) opDesc = 'Manual Row Deletion';
    else if (cleanSql.startsWith('DROP')) opDesc = 'Manual Table Drop';

    const cleanCode = code.endsWith(';') ? code : code + ';';
    const result = runSql(cleanCode, opDesc);

    if (result.success) {
      const data = result.data;
      if (Array.isArray(data) && data.length > 0) {
        // Successful query returned objects
        const firstRow = data[0];
        const headers = typeof firstRow === 'object' && firstRow !== null ? Object.keys(firstRow) : ['Result'];
        const formattedRows = data.map(row => {
          if (typeof row === 'object' && row !== null) {
            return Object.values(row);
          }
          return [row];
        });
        setQueryResult({ headers, rows: formattedRows });
      } else if (Array.isArray(data) && data.length === 0) {
        setQueryResult({ headers: ['Status'], rows: [['Query executed successfully, but returned 0 rows.']] });
      } else {
        // write operation or single state scalar
        setAffectedCount(result.affectedRows ?? 0);
      }
    } else {
      setSqlError(result.error || 'Unknown execution error occurred.');
    }
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-900 text-slate-100 overflow-hidden select-text text-left">
      {/* DB Console Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-indigo-400" />
          <span className="font-mono text-xs font-bold uppercase tracking-widest text-slate-300">
            SQL Query Engine Console
          </span>
          <span className="text-[10px] bg-indigo-950 font-semibold px-2 py-0.5 border border-indigo-800/80 rounded-full text-indigo-300">
            v2.1
          </span>
        </div>
        <button
          onClick={clearSqlLogs}
          className="flex items-center gap-1.5 py-1 px-2.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-slate-900 border border-slate-800 hover:bg-slate-850 hover:text-red-400 cursor-pointer text-slate-400 transition-colors"
          title="Clear system transaction logs"
        >
          <Trash2 size={11} />
          Wipe Logs
        </button>
      </div>

      {/* Grid: Terminal Input on top, logs on bottom or horizontal depending on workspace */}
      <div className={`flex-1 flex ${isSplitView ? 'flex-col' : 'flex-col lg:flex-row'} overflow-hidden`}>
        
        {/* SQL Input & Terminal Stage */}
        <div className="flex-1 flex flex-col border-b lg:border-b-0 lg:border-r border-slate-800 overflow-y-auto p-4 gap-4">
          
          {/* Quick-Pills Template Queries */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] text-slate-500 font-mono font-bold uppercase tracking-wider flex items-center gap-1">
              <Database size={10} /> Schema Templates (Click to load)
            </span>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_QUERIES.map((temp, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setQueryCode(temp.sql);
                    handleRunQuery(temp.sql);
                  }}
                  className="bg-slate-950/80 border border-slate-850 hover:border-indigo-500 hover:text-indigo-300 rounded px-2.5 py-1.5 text-[10px] text-slate-350 cursor-pointer text-left font-mono leading-tight hover:bg-slate-900/80 transition-all flex flex-col gap-0.5 max-w-[200px]"
                  title={temp.desc}
                >
                  <span className="font-semibold text-white text-[11px] font-sans truncate w-full">{temp.label}</span>
                  <span className="text-[9px] text-slate-500 truncate w-full">{temp.sql}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Code Editor Box */}
          <div className="relative border border-slate-750 rounded bg-slate-950 flex flex-col">
            <div className="flex items-center justify-between px-3 py-1 bg-slate-900 border-b border-slate-800 rounded-t text-[10px] font-mono text-slate-400 select-none">
              <span>SQL SCRATCHPAD EDITOR</span>
              <span className="text-slate-600">alasql_database_engine</span>
            </div>
            <textarea
              value={queryCode}
              onChange={(e) => setQueryCode(e.target.value)}
              className="w-full h-24 p-3 font-mono text-xs text-indigo-200 bg-slate-950 focus:outline-hidden resize-none leading-relaxed tracking-wide shadow-inner"
              placeholder="Type raw SQL statements here..."
            />
            {/* Run Button bar inside textarea container */}
            <div className="flex justify-end p-2 border-t border-slate-850 bg-slate-950/50 rounded-b">
              <button
                id="btn-run-sql-query"
                onClick={() => handleRunQuery()}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white rounded text-xs font-bold tracking-wide uppercase hover:from-indigo-500 hover:to-violet-500 shadow-md active:scale-95 transition-all cursor-pointer"
              >
                <Play size={11} fill="white" />
                Run Query
              </button>
            </div>
          </div>

          {/* Results Block */}
          <div className="flex-1 flex flex-col border border-slate-800 rounded bg-slate-950/60 overflow-hidden min-h-[160px]">
            <div className="px-3.5 py-1.5 bg-slate-900/80 border-b border-slate-850 text-[10px] font-mono text-slate-400 flex items-center justify-between">
              <span>QUERY RESULT TERMINAL</span>
              {queryResult && (
                <span className="text-emerald-400 font-bold">{queryResult.rows.length} rows returned</span>
              )}
              {affectedCount !== null && (
                <span className="text-amber-400 font-bold">{affectedCount} rows affected</span>
              )}
            </div>

            <div className="flex-1 overflow-auto p-2">
              {sqlError && (
                <div className="p-3 bg-red-950/40 rounded border border-red-900/60 text-red-300 font-mono text-xs flex items-start gap-2 leading-relaxed">
                  <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-red-200">SQL Exception:</span> {sqlError}
                  </div>
                </div>
              )}

              {affectedCount !== null && (
                <div className="p-3 bg-indigo-950/20 rounded border border-indigo-900/40 text-indigo-250 font-mono text-xs flex items-center gap-2">
                  <CheckCircle2 size={13} className="text-indigo-400" />
                  <span>Statement processed successfully. Affected rows counter: <strong className="text-white text-sm">{affectedCount}</strong></span>
                </div>
              )}

              {queryResult && (
                <div className="overflow-x-auto rounded border border-slate-850 shadow-inner">
                  <table className="w-full text-left font-mono text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-900 border-b border-slate-800">
                        {queryResult.headers.map((h, i) => (
                          <th key={i} className="px-3 py-2 text-slate-300 font-extrabold border-r border-slate-800 uppercase tracking-wider text-[10px]">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-850">
                      {queryResult.rows.map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-indigo-950/20 transition-all odd:bg-slate-950/20">
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="px-3 py-2 text-slate-350 border-r border-slate-850 truncate max-w-[150px]" title={String(cell)}>
                              {cell === null ? <em className="text-slate-650 font-normal">NULL</em> : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!sqlError && !queryResult && affectedCount === null && (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2 py-8 select-none">
                  <Code size={20} className="stroke-1 opacity-70" />
                  <span className="text-[11px] font-mono tracking-wider">AWAITING SQL SEED / INPUT STATEMENTS</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Database Live Activity Log Side Column */}
        <div className="lg:w-80 border-t lg:border-t-0 border-slate-800 flex flex-col overflow-hidden bg-slate-950">
          <div className="px-4 py-2 border-b border-slate-800 bg-slate-900 font-mono text-[10px] text-slate-400 font-bold uppercase tracking-wider flex items-center justify-between">
            <span>REAL-TIME TRANSACTION LEDGER</span>
            <span className="text-[9px] text-indigo-400">({logs.length}) logs</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-900">
            {logs.length === 0 ? (
              <div className="p-4 text-center text-slate-650 text-xs font-mono select-none">
                No SQL transactions detected in current sandbox session.
              </div>
            ) : (
              logs.map((log, logIdx) => (
                <div key={log.id} className="p-3 text-[11px] font-mono hover:bg-slate-900/40 relative group">
                  {/* Status Badges */}
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-slate-500 text-[10px]">{log.timestamp}</span>
                    <div className="flex items-center gap-1 text-[9px] font-sans">
                      <span className={`px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wide text-[8px] ${
                        log.isError ? 'bg-red-950 text-red-400 border border-red-900/60' : 'bg-emerald-950 text-emerald-400 border border-emerald-900/60'
                      }`}>
                        {log.isError ? 'Error' : 'Success'}
                      </span>
                      <span className="text-slate-500">{log.executionTimeMs}ms</span>
                    </div>
                  </div>

                  {/* Operation Sub-title Description */}
                  <span className="text-slate-200 text-xs font-sans font-semibold tracking-wide block mb-1">
                    {log.description}
                  </span>

                  {/* Serial SQL statement block */}
                  <div className="bg-slate-950 p-2 rounded-md border border-slate-850 text-[10px] text-indigo-300 font-mono whitespace-pre-wrap break-all break-words relative">
                    {log.sql}
                    
                    {/* Copy and Quick-run controls */}
                    <div className="absolute right-1 bottom-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => copyToClipboard(log.sql, logIdx)}
                        className="p-1 rounded bg-slate-900 hover:bg-indigo-900 text-slate-400 hover:text-white cursor-pointer transition-colors"
                        title="Copy SQL Query"
                      >
                        {copiedIndex === logIdx ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
                      </button>
                      <button
                        onClick={() => {
                          setQueryCode(log.sql);
                          handleRunQuery(log.sql);
                        }}
                        className="p-1 rounded bg-slate-900 hover:bg-emerald-900 text-slate-400 hover:text-white cursor-pointer transition-colors"
                        title="Load with Console"
                      >
                        <Play size={10} />
                      </button>
                    </div>
                  </div>

                  {/* Error Statement Detail Display */}
                  {log.isError && log.errorMessage && (
                    <div className="text-[10px] text-red-400 font-semibold mt-1 bg-red-950/20 py-0.5 px-1.5 rounded leading-normal border border-red-950">
                      ERR: {log.errorMessage}
                    </div>
                  )}

                  {/* Affected Counter indicator */}
                  {!log.isError && typeof log.affectedRows === 'number' && log.affectedRows > 0 && (
                    <div className="text-[10px] text-emerald-400/80 mt-1">
                      ↪ Affected rows count: {log.affectedRows}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
