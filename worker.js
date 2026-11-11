// Casa Pomare - Worker
const TZ = 'America/Sao_Paulo';

function cors(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(dados, status, request) {
  const h = cors(request);
  h['Content-Type'] = 'application/json; charset=utf-8';
  h['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(dados), { status: status || 200, headers: h });
}

function igualSeguro(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function chaveHmac(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_TOKEN),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function gerarSessao(env) {
  const expira = String(Date.now() + 8 * 60 * 60 * 1000);
  const chave = await chaveHmac(env);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(expira));
  const hex = Array.from(new Uint8Array(sig)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return expira + '.' + hex;
}

async function sessaoValida(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.indexOf('Bearer ') !== 0) return false;
  const p = auth.slice(7).trim().split('.');
  if (p.length !== 2) return false;
  if (!Number(p[0]) || Date.now() > Number(p[0])) return false;
  const chave = await chaveHmac(env);
  const sig = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(p[0]));
  const hex = Array.from(new Uint8Array(sig)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return hex === p[1];
}

async function lerProdutos(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, nome, descricao, preco_centavos, categoria, ativo, imagem_url FROM produtos ORDER BY ordem ASC, nome ASC'
  ).all();
  return results.map(function (p) {
    return {
      id: String(p.id),
      nome: p.nome,
      descricao: p.descricao || '',
      preco: Number(p.preco_centavos) / 100,
      categoria: String(p.categoria || 'outros').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      disponivel: Number(p.ativo) === 1,
      imagem_url: p.imagem_url || ''
    };
  });
}

async function lerConfig(env) {
  const { results } = await env.DB.prepare('SELECT chave, valor FROM config').all();
  const o = {};
  for (const l of results) {
    try { o[l.chave] = JSON.parse(l.valor); } catch (e) { o[l.chave] = l.valor; }
  }
  return o;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });

    try {
      const url = new URL(request.url);
      const caminho = url.pathname;
      const metodo = request.method;

      // ---------- LOGIN ----------
      if (caminho === '/api/login' && metodo === 'POST') {
        const corpo = await request.json().catch(function () { return null; });
        if (!corpo || !corpo.senha) return json({ erro: 'Informe a credencial' }, 400, request);
        if (!igualSeguro(corpo.senha, env.ADMIN_TOKEN)) return json({ erro: 'Credencial incorreta' }, 401, request);
        return json({ token: await gerarSessao(env), expira_em_horas: 8 }, 200, request);
      }

      // ---------- PUBLICO ----------
      if (caminho === '/api/public/catalogo' && metodo === 'GET') {
        return json({ produtos: await lerProdutos(env), config: await lerConfig(env) }, 200, request);
      }
      
      if (caminho.indexOf('/api/imagem/') === 0 && metodo === 'GET') {
        const nome = decodeURIComponent(caminho.replace('/api/imagem/', ''));
        if (!nome) return json({ erro: 'Nome ausente' }, 400, request);
        const obj = await env.BUCKET.get(nome);
        if (!obj) return json({ erro: 'Imagem nao encontrada' }, 404, request);
        return new Response(obj.body, { status: 200, headers: {
          'Content-Type': obj.httpMetadata ? obj.httpMetadata.contentType : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable'
        }});
      }

      // ---------- PROTEGIDO ----------
      if (!(await sessaoValida(request, env))) return json({ erro: 'Nao autorizado' }, 401, request);

    

         if (caminho === '/api/produtos' && metodo === 'POST') {
        const c = await request.json();
        const nome = (c.nome || '').trim();
        const preco = Number(c.preco);
        if (!nome) return json({ erro: 'Nome e obrigatorio' }, 400, request);
        if (!(preco > 0)) return json({ erro: 'Preco invalido' }, 400, request);
        const r = await env.DB.prepare(
          'INSERT INTO produtos (nome, descricao, preco_centavos, categoria, ativo, imagem_url, ordem) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(nome, c.descricao || '', Math.round(preco * 100),
               c.categoria || 'outros', c.disponivel === false ? 0 : 1,
               c.imagem_url || '', 0).run();
        return json({ id: r.meta ? r.meta.last_row_id : null }, 201, request);
      }

      const m = caminho.match(/^\/api\/produtos\/([^/]+)$/);

           if (m && metodo === 'PUT') {
        const c = await request.json();
        const nome = (c.nome || '').trim();
        const preco = Number(c.preco);
        if (!nome) return json({ erro: 'Nome e obrigatorio' }, 400, request);
        if (!(preco > 0)) return json({ erro: 'Preco invalido' }, 400, request);
        const r = await env.DB.prepare(
          'UPDATE produtos SET nome = ?, descricao = ?, preco_centavos = ?, categoria = ?, ativo = ?, imagem_url = ?, atualizado_em = ? WHERE id = ?'
        ).bind(nome, c.descricao || '', Math.round(preco * 100),
               c.categoria || 'outros', c.disponivel === false ? 0 : 1,
               c.imagem_url || '', new Date().toISOString(), Number(m[1])).run();
        if (r.meta && r.meta.changes === 0) return json({ erro: 'Nao encontrado' }, 404, request);
        return json({ ok: true }, 200, request);
      }
      
            if (m && metodo === 'DELETE') {
        await env.DB.prepare('DELETE FROM produtos WHERE id = ?').bind(Number(m[1])).run();
        return new Response(null, { status: 204, headers: cors(request) });
      }

      if (caminho === '/api/config' && metodo === 'GET') return json(await lerConfig(env), 200, request);

      if (caminho === '/api/config' && metodo === 'PUT') {
        const c = await request.json();
        const agora = new Date().toISOString();
        const stmts = [];
        for (const k in c) {
          if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
          stmts.push(env.DB.prepare('INSERT OR REPLACE INTO config (chave, valor, atualizado_em) VALUES (?, ?, ?)')
            .bind(k, JSON.stringify(c[k]), agora));
        }
        if (stmts.length) await env.DB.batch(stmts);
        return json({ ok: true }, 200, request);
      }

      // Upload usando o binding BUCKET, que e o nome real da sua conta.
      if (caminho === '/api/upload' && metodo === 'POST') {
        const form = await request.formData();
        const arq = form.get('arquivo');
        if (!arq || typeof arq === 'string') return json({ erro: 'Arquivo ausente' }, 400, request);
        if (!arq.type || arq.type.indexOf('image/') !== 0) return json({ erro: 'Somente imagens' }, 400, request);
        if (arq.size > 4 * 1024 * 1024) return json({ erro: 'Imagem maior que 4 MB' }, 400, request);
        const ext = arq.type === 'image/png' ? 'png' : arq.type === 'image/webp' ? 'webp' : arq.type === 'image/gif' ? 'gif' : 'jpg';
        const nome = crypto.randomUUID() + '.' + ext;
        await env.BUCKET.put(nome, arq.stream(), { httpMetadata: { contentType: arq.type } });
        return json({ url: '/api/imagem/' + nome }, 201, request);
      }

      return json({ erro: 'Rota nao encontrada' }, 404, request);

       } catch (err) {
      console.error('Erro:', err && err.stack ? err.stack : err);
      return json({
        erro: 'Erro interno',
        detalhe: String(err && err.message ? err.message : err)
      }, 500, request);
    }
  }
};
