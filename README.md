# Configuration Pi

Ce dépôt contient ma configuration globale de [Pi](https://github.com/badlogic/pi-mono) dans `~/.pi/agent` : réglages, extensions locales, paquets, agents et skills. Les identifiants, sessions et dépendances installées restent locaux et ne sont pas suivis par Git.

## Réglages

[`settings.json`](settings.json) définit actuellement :

- fournisseur et modèle par défaut : `openai` / `gpt-6.1-sol` ;
- thème sombre et blocs de raisonnement masqués ;
- télémétrie d'installation et analytics désactivés ;
- outil `codemode` activé ;
- fichiers `*.test.ts` exclus du chargement des extensions.

Les instructions globales de délégation et de planification sont gérées par `senpi-prompt`. Les modèles, serveurs de langage et MCP se configurent respectivement dans `models-store.json`, [`lsp.json`](lsp.json) et [`mcp.json`](mcp.json). `models-store.json` est local et ignoré par Git.

## Extensions locales

Pi charge automatiquement les extensions de [`extensions/`](extensions/).

| Extension | Fonction |
| --- | --- |
| `ask-user-question.ts` | Outils `ask_user_question` et `ask_question` pour poser une question avec réponse libre ou choix. |
| `move-tool.ts` | Outil `move` pour déplacer une plage de lignes entre fichiers ou dans un même fichier. |
| `copy-tool.ts` | Outil `copy` pour copier une plage de lignes sans modifier la source ; reprend les options de placement de `move`. |
| `terminal/` | Terminal persistant : `bash`, `bash_output`, `bash_input`, `bash_resize`, `kill_bash` et `monitor`. |
| `prompt-snippets/` | Fragments de prompt activables avec `/snippets` ou `Alt+S`. |
| `history-search/` | `/history` : recherche parmi les prompts des sessions et remet le résultat choisi dans l'éditeur. |
| `openai-web-search/` | Active la recherche web native pour les modèles compatibles des fournisseurs OpenAI et OpenAI Codex. |
| `senpi-prompt/` | Ajoute des sections du prompt dynamique de Senpi et, pour les modèles GPT, des consignes adaptées aux outils de fichiers actifs. |
| `plan-workflow/` | Workflow plan puis exécution pour Pi en mode RPC, notamment dans T3 Code. |

Les outils `move` et `copy` acceptent une plage de lignes et une destination avec insertion au début, à la fin, avant ou après une ligne. Ils effectuent un aperçu par défaut : utiliser `dry_run: false` pour appliquer la modification. Le réglage d'indentation est facultatif et approximatif ; vérifier le résultat et les imports après application.

Le prompt dynamique est une **adaptation partielle** des sections de Senpi, pas son constructeur de prompt ni tous ses presets par modèle. La recherche native utilise `web_search` pour OpenAI Responses et OpenAI Codex lorsque le modèle et le point d'accès sont compatibles ; un réglage de compatibilité peut remplacer ce type. `PI_OPENAI_WEB_SEARCH=0` la désactive.

## Planification et exécution dans T3 Code

Lancer `/plan <demande>` dans une session Pi pour préparer un plan. L’agent explore avec les outils de lecture disponibles, décrit le résultat, les contraintes, les risques, les étapes et leurs vérifications, puis présente le plan dans un dialogue. **Une confirmation explicite démarre immédiatement l’exécution** ; un refus conserve le plan en préparation.

Pendant la préparation et en pause, le garde-fou bloque les outils Pi non autorisés, notamment les écritures, le shell, `codemode` et la délégation. Les outils de lecture et de question disponibles dans le harness restent utilisables. Cette protection concerne les appels qui passent par les hooks de cette session Pi : ce n’est pas une sandbox, et elle ne contrôle pas les autres sessions, processus ou actions déjà lancées.

Commandes :

- `/plan status` : afficher l’état du plan de la session.
- `/plan pause` : suspendre l’exécution et demander l’interruption du tour actif.
- `/plan resume` : reprendre dans la même session un plan approuvé et inchangé.
- `/plan cancel` : arrêter le workflow de la session.

L’état, l’historique des transitions, les preuves déclarées par étape et une copie du plan approuvé sont stockés sous `~/.pi/agent/plan-workflow-state/`, hors Git. Le plan approuvé est lié à son empreinte SHA-256 : une modification du fichier bloque les outils d’exécution et la reprise. Les étapes peuvent avoir des dépendances ; leur avancement utilise l’outil `todo` déjà installé dans Pi et l’état du workflow reste consultable via `plan_status`. Les étapes reçoivent un identifiant propre au plan et sont ajoutées à une phase `todo` sans réinitialiser les tâches existantes. Le workflow observe les résultats `todo` pour retrouver leur avancement. Les preuves sont enregistrées mais ne sont pas validées automatiquement par le code.

T3 lance Pi en RPC et injecte son pont MCP : `mcp__t3-code__orchestrator_capabilities`, `mcp__t3-code__delegate_task` et `mcp__t3-code__task_status` sont exposés directement ; d’autres outils peuvent être découverts avec `tool_search`. L’agent vérifie leur disponibilité quand il en a besoin et suit les instructions d’orchestration fournies par T3. Pendant le plan, le garde-fou autorise uniquement les outils T3 de consultation explicitement reconnus et bloque la délégation.

Le dialogue de confirmation Pi est transmis à T3 comme une demande d’approbation. Les résultats des outils T3 de délégation sont observés lorsqu’ils proviennent du pont officiel ; un plan ne peut pas être clôturé tant qu’une tâche observée reste active. Les preuves restent déclaratives. La pause et l’annulation du plan n’annulent pas automatiquement les sous-agents T3 déjà lancés : utiliser l’outil T3 `task_cancel` ou l’interface T3.

Ce workflow ne change pas un mode Plan natif de T3 ; dans l’adaptateur Pi installé, le sélecteur de mode Plan est désactivé. Le garde-fou ne contrôle ni les autres sessions ni les processus déjà lancés. La reprise automatique dans une nouvelle session et le registre Boulder d’OMO ne sont pas implémentés.

## Paquets configurés

La liste de référence est `packages` dans [`settings.json`](settings.json).

| Paquet | Fonction |
| --- | --- |
| `FRFlo/pi-web-search` | Recherche web. |
| `code-yeongyu/pi-apply-patch` | Outil `apply_patch`. |
| `pi-antigravity` | Fournisseur et gestion des comptes Antigravity. |
| `pi-lsp` | Intégration des serveurs de langage ; configuration dans `lsp.json`. |
| `code-yeongyu/pi-todotools` | Outil `todo` : tâches organisées en phases et persistées dans la session. |
| `code-yeongyu/pi-goal` | Objectifs persistants : `/goal`, `create_goal`, `get_goal` et `update_goal`. |
| `code-yeongyu/pi-nested-agents-md` | Charge les `AGENTS.md` des dossiers imbriqués lors de la lecture de fichiers. |
| `code-yeongyu/pi-webfetch` | Lit une URL en Markdown, texte ou HTML. |

`webfetch` est distinct de la recherche web : il récupère le contenu d'une URL, tandis que les outils de recherche trouvent des sources. Le serveur MCP Cloudflare Browser configuré offre aussi des capacités de navigateur ; ses outils disponibles dépendent de la connexion MCP.

## MCP, agents et skills

[`mcp.json`](mcp.json) et [`mcp-adapter.json`](mcp-adapter.json) contiennent la configuration des serveurs MCP, notamment Context7, GitHub, Cloudflare, grep.app, PostHog, Svelte et GitNexus. Certains serveurs nécessitent des variables d'environnement, une authentification ou un exécutable local ; la présence d'une entrée ne garantit pas que le serveur soit disponible.

Les profils d'agents sont dans [`agents/`](agents/) : `Explore`, `general-purpose` et `Plan`. Les skills propres au dépôt sont dans [`skills/`](skills/) : `analyze-sessions`, `pdf-reader`, `web-debug` et `youtube-transcript`. D'autres skills peuvent être chargés depuis des dossiers externes à ce dépôt.

## Installation et maintenance

1. Installer Pi, Git et Node.js, puis placer ce dépôt dans `~/.pi/agent`.
2. Restaurer séparément les fichiers locaux nécessaires depuis une sauvegarde privée : en particulier `auth.json`, `mcp-auth.json`, `preferences.json` et `trust.json`, selon les services utilisés. Ne pas les commiter.
3. Installer les paquets déclarés dans `settings.json` avec `pi install <source>` si leurs dossiers ne sont pas déjà présents. Les paquets Git sont stockés sous `git/` et les paquets npm sous `npm/`.
4. Installer les dépendances des extensions locales. Sous Windows, `./install-extensions.ps1` parcourt les dossiers `extensions/` et `git/` contenant un `package.json` ; des variantes `.cmd` et `.sh` sont aussi fournies. Les dépendances npm globales du setup sont définies dans [`npm/package.json`](npm/package.json).
5. Redémarrer Pi ou utiliser `/reload` après un changement d'extension.

Par exemple :

```powershell
pi install git:github.com/code-yeongyu/pi-goal
./install-extensions.ps1
```

Les `node_modules`, dépôts de paquets Git et binaires ne sont pas sauvegardés par Git. La configuration de `lugo` fait notamment référence à `~/.pi/agent/bin/lugo-mcp.exe` : cet exécutable doit être installé séparément pour que ce serveur fonctionne.

## Sauvegardes et données locales

Les règles complètes sont dans [`.gitignore`](.gitignore). Elles excluent notamment les identifiants, les préférences locales, les sessions, les caches et les dépendances. Les sauvegardes `~/.pi/agent-save-selection` et `~/.pi/agent-old`, si elles existent, sont distinctes de ce dépôt. Elles peuvent contenir des secrets ou des historiques : les conserver de manière privée.

Les éléments adaptés de Senpi conservent leur licence MIT dans les dossiers concernés sous `extensions/`.
