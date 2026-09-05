import { assertEquals } from '@std/assert';
import { dirname, fromFileUrl } from '@std/path';

const repositoryRoot = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test('Python BetterBrowse 客户端单元与协议测试全部通过', async () => {
  const pythonExecutable = Deno.env.get('PYTHON') || 'python';
  const output = await new Deno.Command(pythonExecutable, {
    args: ['-B', '-m', 'unittest', 'discover', '-s', 'tests/python', '-p', 'test_*.py', '-v'],
    cwd: repositoryRoot,
    stdout: 'piped',
    stderr: 'piped'
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, `Python 客户端测试失败：\n${stdout}\n${stderr}`);
});
