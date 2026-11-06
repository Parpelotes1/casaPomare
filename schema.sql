DROP TABLE IF EXISTS produtos;
CREATE TABLE produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  descricao TEXT,
  preco_centavos INTEGER NOT NULL DEFAULT 0,
  categoria TEXT NOT NULL DEFAULT 'Outros',
  imagem_url TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP TABLE IF EXISTS config;
CREATE TABLE config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP TABLE IF EXISTS pedidos;
CREATE TABLE pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_nome TEXT,
  cliente_telefone TEXT,
  tipo_entrega TEXT NOT NULL DEFAULT 'entrega',
  endereco TEXT,
  observacoes TEXT,
  itens_json TEXT NOT NULL,
  total_centavos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'novo',
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_produtos_ativo_ordem ON produtos(ativo, ordem);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado ON pedidos(criado_em);

INSERT INTO config (chave, valor) VALUES
  ('loja_aberta', '1'),
  ('whatsapp', '5516992874030'),
  ('horario_semana', 'Seg a Sex: 08:00 - 19:00'),
  ('horario_sabado', 'Sab: 08:00 - 18:00'),
  ('horario_domingo', 'Dom: fechado'),
  ('aviso_fechado', 'Estamos fechados no momento. Voce pode montar seu pedido e enviar - responderemos no horario de funcionamento.'),
  ('endereco', 'Rua 26, 670A - Jardim Paineiras, Orlandia/SP - CEP 14622-396'),
  ('email', 'arq.mjpollo@gmail.com'),
  ('responsaveis', 'Maria Julia e Julio Cesar');
