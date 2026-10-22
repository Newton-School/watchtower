import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SlackText } from '../lib/slackText';
import { emojiChar, searchEmoji } from '../lib/emoji';

const users = { U1: { name: 'theOG', avatarUrl: null, isBot: false } };

function html(text: string): string {
  return render(<SlackText text={text} users={users} />).container.innerHTML;
}

describe('SlackText', () => {
  it('renders mentions, links and channels the way Slack shows them', () => {
    const out = html('hi <@U1>, see <https://x.co/a?b=1&amp;c=2|the doc> in <#C9|general> <!here> <@U404>');
    expect(out).toContain('<span class="slack-mention">@theOG</span>');
    expect(out).toContain('href="https://x.co/a?b=1&amp;c=2"');
    expect(out).toContain('>the doc</a>');
    expect(out).toContain('#general');
    expect(out).toContain('@here');
    expect(out).toContain('@U404');
  });

  it('formats bold, italic, strike, code and emoji but leaves snake_case alone', () => {
    const out = html('*bold* _soft_ ~gone~ `a<b` :pray: :custom_party: my_var_name 2*3*4');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>soft</em>');
    expect(out).toContain('<s>gone</s>');
    expect(out).toContain('<code class="slack-inline-code">a&lt;b</code>');
    expect(out).toContain('🙏');
    expect(out).toContain(':custom_party:');
    expect(out).toContain('my_var_name 2*3*4');
  });

  it('renders code blocks and quotes as blocks and decodes entities', () => {
    const out = html('before\n```\nconst a = 1 &amp;&amp; b;\n```\n&gt; quoted <@U1>\nafter &lt;3');
    expect(out).toContain('<pre class="slack-code-block">const a = 1 &amp;&amp; b;\n</pre>');
    expect(out).toContain(
      '<blockquote class="slack-quote">quoted <span class="slack-mention">@theOG</span></blockquote>',
    );
    expect(out).toContain('after &lt;3');
  });
});

describe('emoji', () => {
  it('maps Slack names, aliases and skin tones', () => {
    expect(emojiChar('eyes')).toBe('👀');
    expect(emojiChar('thumbsup')).toBe(emojiChar('+1'));
    expect(emojiChar('+1::skin-tone-3')).toBe('👍🏼');
    expect(emojiChar('not_an_emoji')).toBeNull();
  });

  it('finds emoji by name, prefix matches first', () => {
    const names = searchEmoji('pra').map(emoji => emoji.names[0]);
    expect(names[0]).toBe('pray');
    expect(searchEmoji('   ')).toEqual([]);
  });
});
