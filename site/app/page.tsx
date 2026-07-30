const repositoryUrl = "https://github.com/monteduro/unlocalhost";

function Brand({ footer = false }: { footer?: boolean }) {
  return (
    <span className={`brand ${footer ? "brandFooter" : ""}`}>
      <span className="brandMark" aria-hidden="true">
        <span className="brandPrompt">&gt;_</span>
        <span className="brandEscape">↗</span>
      </span>
      <span className="brandName">
        <span>un</span>localhost
      </span>
    </span>
  );
}

function Check() {
  return (
    <span className="check" aria-hidden="true">
      ✓
    </span>
  );
}

export default function Home() {
  return (
    <main>
      <header className="siteHeader">
        <a className="brandLink" href="#top" aria-label="unlocalhost home">
          <Brand />
        </a>
        <nav aria-label="Primary navigation">
          <a href="#why">Why</a>
          <a href="#how">How it works</a>
          <a href="#install">Install</a>
          <a className="navCta" href={repositoryUrl}>
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>

      <section className="hero shell" id="top">
        <div className="heroCopy">
          <div className="eyebrow">
            <span className="statusDot" />
            Open-source alpha · macOS + Linux
          </div>
          <h1>
            Develop locally.
            <br />
            <span>Work from anywhere.</span>
          </h1>
          <p className="heroLead">
            unlocalhost keeps your real development environment on your own
            machine—and gives every project a stable HTTPS URL.
          </p>
          <div className="heroActions">
            <a className="button buttonPrimary" href="#install">
              Install the alpha
              <span aria-hidden="true">→</span>
            </a>
            <a className="button buttonGhost" href="#not-a-deploy">
              See the difference
            </a>
          </div>
          <div className="heroProof">
            <span>
              <Check /> Docker &amp; Node
            </span>
            <span>
              <Check /> Vite/HMR
            </span>
            <span>
              <Check /> Zero repo changes
            </span>
          </div>
        </div>

        <div className="terminalWrap" aria-label="Example unlocalhost session">
          <div className="route routeOne" />
          <div className="route routeTwo" />
          <div className="terminal">
            <div className="terminalBar">
              <div className="terminalDots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <span>dev-machine — zsh</span>
              <span className="terminalLive">live</span>
            </div>
            <div className="terminalBody">
              <p>
                <span className="prompt">$</span> unlocalhost add ~/Sites/acme
                <br />
                <span className="indent">--slug acme --services web:80</span>
              </p>
              <p className="terminalMuted">Compose endpoints registered</p>
              <p>
                <span className="prompt">$</span> unlocalhost up acme
              </p>
              <div className="terminalResult">
                <span className="resultDot" />
                <div>
                  <strong>acme is reachable</strong>
                  <a href="#install">
                    https://acme.localhost:8443
                  </a>
                  <a href="#install">https://acme.dev.example.com</a>
                </div>
              </div>
              <div className="terminalGrid">
                <span>compose</span>
                <strong>running</strong>
                <span>vite / hmr</span>
                <strong>connected</strong>
                <span>repository</span>
                <strong>clean</strong>
              </div>
            </div>
          </div>
          <div className="remoteBadge">
            <span className="remoteIcon" aria-hidden="true">
              ◉
            </span>
            <div>
              <strong>Remote session</strong>
              <span>same environment</span>
            </div>
          </div>
        </div>
      </section>

      <section className="proofStrip" aria-label="Core product principles">
        <div>
          <span>01</span>
          <strong>The code stays.</strong>
          <p>No upload. No remote rebuild.</p>
        </div>
        <div>
          <span>02</span>
          <strong>The whole stack stays.</strong>
          <p>Containers, databases, volumes, HMR.</p>
        </div>
        <div>
          <span>03</span>
          <strong>You move.</strong>
          <p>Open the same environment from anywhere.</p>
        </div>
      </section>

      <section className="section shell" id="why">
        <div className="sectionIntro">
          <p className="kicker">The actual problem</p>
          <h2>
            localhost is a place.
            <br />
            Your work shouldn&apos;t be.
          </h2>
          <p>
            A remote URL is easy. Keeping the real development environment
            intact—without hand-assigning ports or touching team repos—is the
            useful part.
          </p>
        </div>

        <div className="machineMap">
          <div className="mapLabel mapLabelTop">Your machine</div>
          <div className="machineCore">
            <div className="machineHeader">
              <span>localhost</span>
              <span className="machineIp">127.0.0.1</span>
            </div>
            <div className="projectRows">
              <div>
                <span className="projectIcon">A</span>
                <span>
                  <strong>acme</strong>
                  <small>Laravel · Vite · MySQL</small>
                </span>
                <code>:12000</code>
              </div>
              <div>
                <span className="projectIcon blue">S</span>
                <span>
                  <strong>studio</strong>
                  <small>Node · API · Postgres</small>
                </span>
                <code>:12003</code>
              </div>
              <div>
                <span className="projectIcon violet">D</span>
                <span>
                  <strong>dashboard</strong>
                  <small>Next.js · Redis</small>
                </span>
                <code>:12006</code>
              </div>
            </div>
          </div>
          <div className="mapConnector">
            <span />
            <b>Caddy</b>
            <span />
          </div>
          <div className="mapDestinations">
            <div>
              <small>Local HTTPS</small>
              <strong>*.localhost</strong>
            </div>
            <div>
              <small>Optional tunnel</small>
              <strong>*.dev.example.com</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="section sectionDark" id="not-a-deploy">
        <div className="shell">
          <div className="sectionIntro sectionIntroWide">
            <p className="kicker">A different boundary</p>
            <h2>Not a deploy. Your actual environment.</h2>
          </div>
          <div className="comparison">
            <div className="comparisonCard mutedCard">
              <div className="comparisonTitle">
                <span>Typical preview deployment</span>
                <small>copy</small>
              </div>
              <ul>
                <li>Push code to a remote builder</li>
                <li>Recreate one supported runtime</li>
                <li>Provision separate database state</li>
                <li>Debug differences from local</li>
              </ul>
              <div className="comparisonFoot">Your environment moved.</div>
            </div>
            <div className="comparisonArrow" aria-hidden="true">
              ≠
            </div>
            <div className="comparisonCard signalCard">
              <div className="comparisonTitle">
                <span>unlocalhost</span>
                <small>original</small>
              </div>
              <ul>
                <li>Your existing Compose stack</li>
                <li>Your actual database and volumes</li>
                <li>Your Vite server and live HMR</li>
                <li>Your machine, remotely reachable</li>
              </ul>
              <div className="comparisonFoot">
                The environment stayed. You moved.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section shell" id="how">
        <div className="sectionIntro">
          <p className="kicker">One machine-wide setup</p>
          <h2>Project eleven is as easy as project one.</h2>
        </div>
        <div className="steps">
          <article>
            <span className="stepNumber">01</span>
            <div className="stepGlyph">&gt;_</div>
            <h3>Register the project</h3>
            <p>
              Compose or a plain Node process. unlocalhost discovers HTTP
              services and keeps its registry outside the repository.
            </p>
          </article>
          <article>
            <span className="stepNumber">02</span>
            <div className="stepGlyph">⌁</div>
            <h3>Route every endpoint</h3>
            <p>
              Stable loopback ports remove collisions. One Caddy instance gives
              web, API, admin, and Vite their own HTTPS hostnames.
            </p>
          </article>
          <article>
            <span className="stepNumber">03</span>
            <div className="stepGlyph">↗</div>
            <h3>Reach the machine</h3>
            <p>
              Add one optional Cloudflare Tunnel and one wildcard DNS record.
              Every current and future project uses the same route.
            </p>
          </article>
        </div>
      </section>

      <section className="agentSection">
        <div className="shell agentGrid">
          <div>
            <p className="kicker">Agent-ready by design</p>
            <h2>One predictable interface for humans and agents.</h2>
            <p className="agentLead">
              Non-interactive commands, useful failures, versioned JSON status,
              and no hidden changes inside the project.
            </p>
            <div className="agentTags">
              <span>--json</span>
              <span>--yes</span>
              <span>non-zero exits</span>
              <span>stable URLs</span>
            </div>
          </div>
          <div className="agentCode">
            <div className="codeHeader">
              <span>agent instruction</span>
              <span>ready</span>
            </div>
            <pre>
              <code>{`Use unlocalhost.

Inspect this project's HTTP services,
register it without modifying the repo,
start it, verify status, and return the
public HTTPS URL.`}</code>
            </pre>
            <div className="codeResponse">
              <Check />
              <span>Deterministic workflow, inspectable result.</span>
            </div>
          </div>
        </div>
      </section>

      <section className="installSection shell" id="install">
        <div className="installCard">
          <div className="alphaStamp">alpha 0.1</div>
          <div className="installCopy">
            <p className="kicker">Start with one machine</p>
            <h2>Your dev machine is already the dev server.</h2>
            <p>
              unlocalhost is open source and in active alpha. Install the CLI,
              run the doctor, and keep your first project exactly where it is.
            </p>
          </div>
          <div className="installCommand">
            <span className="prompt">$</span>
            <code>npm install -g unlocalhost-cli</code>
          </div>
          <div className="installActions">
            <a className="button buttonPrimary" href={repositoryUrl}>
              View on GitHub <span aria-hidden="true">↗</span>
            </a>
            <a className="textLink" href={repositoryUrl + "#readme"}>
              Read the guide <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>

      <footer>
        <div className="shell footerInner">
          <Brand footer />
          <p>
            The environment stays.
            <br />
            You move.
          </p>
          <div className="footerLinks">
            <a href={repositoryUrl}>GitHub</a>
            <a href={repositoryUrl + "/blob/main/GUIDE.md"}>Guide</a>
            <a href={repositoryUrl + "/blob/main/LICENSE"}>MIT License</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
