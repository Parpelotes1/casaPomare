export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
      });

    const erro = (msg, status = 400) => json({ ok: false, erro: msg }, status);

    const authOk = (req) => {
      const h = req.headers.get('Authorization') || '';
      return h === `Bearer ${env.ADMIN_TOKEN}`;
    };

            if (path === '/api/admin/pedidos' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM pedidos ORDER BY id DESC LIMIT 200'
          ).all();
          return json(results);
        }

        const mPed = path.match(/^\/api\/admin\/pedidos\/(\d+)$/);
        if (mPed && request.method === 'PATCH') {
          const b = await request.json();
          const status = String(b.status || '').trim();
          const permitidos = ['novo', 'em_preparo', 'entregue', 'cancelado'];
          if (!permitidos.includes(status)) return erro('Status invalido.');
          await env.DB.prepare(
            "UPDATE pedidos SET status = ? WHERE id = ?"
          ).bind(status, Number(mPed[1])).run();
          return json({ ok: true });
        }

        if (path === '/api/admin/backup' && request.method === 'GET') {
          const prod = await env.DB.prepare('SELECT * FROM produtos ORDER BY id ASC').all();
          const conf = await env.DB.prepare('SELECT chave, valor FROM config').all();
          const ped  = await env.DB.prepare('SELECT * FROM pedidos ORDER BY id ASC').all();
          return json({
            ok: true,
            gerado_em: new Date().toISOString(),
            versao: 1,
            produtos: prod.results,
            config: conf.results,
            pedidos: ped.results,
          });
        }
    try {
      // ---------- PUBLICO ----------
      if (path === '/api/produtos' && request.method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM produtos WHERE ativo = 1 ORDER BY ordem ASC, id ASC'
        ).all();
        return json(results);
      }

      if (path === '/api/config' && request.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT chave, valor FROM config').all();
        const obj = {};
        for (const r of results) obj[r.chave] = r.valor;
        return json(obj);
      }

      if (path === '/api/pedido' && request.method === 'POST') {
        const b = await request.json();
        if (!b.itens || !Array.isArray(b.itens) || b.itens.length === 0) {
          return erro('O pedido precisa ter pelo menos um item.');
        }
        const total = b.itens.reduce(
          (s, i) => s + (Number(i.preco_centavos) || 0) * (Number(i.qtd) || 0),
          0
        );
        const r = await env.DB.prepare(
          `INSERT INTO pedidos
           (cliente_nome, cliente_telefone, tipo_entrega, endereco, observacoes, itens_json, total_centavos)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            b.cliente_nome || null,
            b.cliente_telefone || null,
            b.tipo_entrega || 'entrega',
            b.endereco || null,
            b.observacoes || null,
            JSON.stringify(b.itens),
            total
          )
          .run();
        return json({ ok: true, id: r.meta.last_row_id, total_centavos: total });
      }

      // ---------- ADMIN ----------
      if (path.startsWith('/api/admin/')) {
        if (!authOk(request)) return erro('Token invalido ou ausente.', 401);

        // Upload de foto do produto
        if (path === '/api/admin/upload' && request.method === 'POST') {
          const form = await request.formData();
          const arquivo = form.get('imagem');
          if (!arquivo || typeof arquivo === 'string') {
            return erro('Nenhuma imagem enviada.');
          }
          if (!arquivo.type.startsWith('image/')) {
            return erro('O arquivo precisa ser uma imagem.');
          }
          if (arquivo.size > 5 * 1024 * 1024) {
            return erro('A imagem pode ter no maximo 5 MB.');
          }

          const ext = (arquivo.name.split('.').pop() || 'jpg').toLowerCase();
          const key = `produtos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

          await env.BUCKET.put(key, arquivo.stream(), {
            httpMetadata: { contentType: arquivo.type },
          });

          const base = env.R2_PUBLIC_URL.replace(/\/$/, '');
          return json({ ok: true, key, url: `${base}/${key}` }, 201);
        }

        if (path === '/api/admin/produtos' && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM produtos ORDER BY ordem ASC, id ASC'
          ).all();
          return json(results);
        }

        if (path === '/api/admin/produtos' && request.method === 'POST') {
          const b = await request.json();
          if (!b.nome) return erro('O nome do produto e obrigatorio.');
          const r = await env.DB.prepare(
            `INSERT INTO produtos (nome, descricao, preco_centavos, categoria, imagem_url, ativo, ordem)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(
              b.nome,
              b.descricao || null,
              Number(b.preco_centavos) || 0,
              b.categoria || 'Outros',
              b.imagem_url || null,
              b.ativo === false ? 0 : 1,
              Number(b.ordem) || 0
            )
            .run();
          return json({ ok: true, id: r.meta.last_row_id }, 201);
        }

        const mProd = path.match(/^\/api\/admin\/produtos\/(\d+)$/);
        if (mProd) {
          const id = Number(mProd[1]);

          if (request.method === 'PUT') {
            const b = await request.json();
            await env.DB.prepare(
              `UPDATE produtos SET
                 nome = COALESCE(?, nome),
                 descricao = COALESCE(?, descricao),
                 preco_centavos = COALESCE(?, preco_centavos),
                 categoria = COALESCE(?, categoria),
                 imagem_url = COALESCE(?, imagem_url),
                 ativo = COALESCE(?, ativo),
                 ordem = COALESCE(?, ordem),
                 atualizado_em = datetime('now')
               WHERE id = ?`
            )
              .bind(
                b.nome ?? null,
                b.descricao ?? null,
                b.preco_centavos ?? null,
                b.categoria ?? null,
                b.imagem_url ?? null,
                b.ativo === undefined ? null : b.ativo ? 1 : 0,
                b.ordem ?? null,
                id
              )
              .run();
            return json({ ok: true });
          }

          if (request.method === 'DELETE') {
            // Remove a imagem do R2 tambem, se existir
            const { results } = await env.DB.prepare(
              'SELECT imagem_url FROM produtos WHERE id = ?'
            )
              .bind(id)
              .all();
            if (results.length && results[0].imagem_url) {
              const base = env.R2_PUBLIC_URL.replace(/\/$/, '');
              if (results[0].imagem_url.startsWith(base)) {
                const key = results[0].imagem_url.slice(base.length + 1);
                await env.BUCKET.delete(key);
              }
            }
            await env.DB.prepare('DELETE FROM produtos WHERE id = ?').bind(id).run();
            return json({ ok: true });
          }
        }

        if (path === '/api/admin/config' && request.method === 'PATCH') {
          const b = await request.json();
          const entradas = Object.entries(b);
          if (entradas.length === 0) return erro('Nenhuma configuracao enviada.');
          for (const [chave, valor] of entradas) {
            await env.DB.prepare(
              `INSERT INTO config (chave, valor, atualizado_em)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')`
            )
              .bind(chave, String(valor))
              .run();
          }
          return json({ ok: true });
        }

        return erro('Rota de admin nao encontrada.', 404);
      }

      // ---------- ESTATICOS ----------
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response('Arquivo nao encontrado', { status: 404 });
    } catch (e) {
      return erro('Erro interno: ' + e.message, 500);
    }
  },
};
