import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class ProcessManager {
    static async isAntigravityRunning(): Promise<boolean> {
        try {
            const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq antigravity.exe" /NH');
            return stdout.toLowerCase().includes('antigravity.exe');
        } catch (e) {
            return false;
        }
    }

    static async closeAntigravity(): Promise<boolean> {
        if (!(await this.isAntigravityRunning())) {
            return true;
        }

        try {
            console.log('Sending taskkill...');
            await execAsync('taskkill /F /IM antigravity.exe');
            
            // Wait for process to disappear
            for (let i = 0; i < 20; i++) { // Max 10 seconds
                await new Promise(resolve => setTimeout(resolve, 500));
                if (!(await this.isAntigravityRunning())) {
                    console.log('Antigravity process gone.');
                    return true;
                }
            }
            
            console.error('Antigravity process still exists after timeout.');
            return false;
        } catch (e) {
            console.error('Failed to close Antigravity', e);
            return false;
        }
    }

    static async startAntigravity() {
        try {
            console.log('Starting Antigravity via PowerShell Start-Process...');
            // Use PowerShell Start-Process for reliable detached execution
            const child = spawn('powershell', ['-Command', "Start-Process 'antigravity://'"], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
        } catch (e) {
            console.error('Failed to start Antigravity', e);
        }
    }
}
