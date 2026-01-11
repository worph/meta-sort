import {config} from "../config/EnvConfig.js";
import axios from "axios";

export class JellyfinAPI {

    constructor() {

    }

    async getMetaData(filepath: string): Promise<any> {
        console.log("geteMetaData");
    }

    private async sendAuthedRequest(url: string, method: string, data?: any, params?: any) {
        return (await axios({
            method: method,
            url: url,
            headers: {
                'X-MediaBrowser-Token': config.JELLYFIN_API_KEY
            },
            data: data,
            params: params
        })).data;
    }

    private async getRootUserId(): Promise<string> {
        const users = await this.sendAuthedRequest(`${config.JELLYFIN_ENDPOINT}/Users`, 'GET');
        for (const user of users) {
            if (user.Policy.IsAdministrator) {
                return user.Id;
            }
        }
        return users[0].Id;
    }

    private async getItemIdByFilePath(filePath: string): Promise<string | null> {
        try {
            let user = await this.getRootUserId();
            const items = await this.sendAuthedRequest(`${config.JELLYFIN_ENDPOINT}/Items`, 'GET', null, {
                Path: encodeURIComponent(filePath),
                userId: user
            });

            if (items.Items && items.Items.length > 0) {
                return items.Items[0].Id;
            } else {
                console.log(`Item with file path "${filePath}" not found.`);
                return null;
            }
        } catch (error) {
            console.error('Error fetching item ID by file path:', error.message);
            return null;
        }
    }

    jellyApiAvailable(): boolean {
        return !!config.JELLYFIN_API_KEY && !!config.JELLYFIN_ENDPOINT;
    }

    /** takes around 30s to complete (if light update) */
    async refreshLibrary(): Promise<void>{
        try {
            const response = await this.sendAuthedRequest(`${config.JELLYFIN_ENDPOINT}/Library/Refresh`, "POST",null, {
                headers: {
                    'X-MediaBrowser-Token': config.JELLYFIN_API_KEY
                }
            });
        } catch (error) {
            console.error('Error refreshing library:', error.message);
        }
    }

    async notifyJellyfin(filePath): Promise<void> {
        const itemId = await this.getItemIdByFilePath(filePath);
        if(!itemId) {
            return;
        }
        // Fetch the public system info
        const response = await axios.post(`${config.JELLYFIN_ENDPOINT}/Items/${itemId}/Refresh`, {

        },{
            headers: {
                'X-MediaBrowser-Token': config.JELLYFIN_API_KEY
            }
        });
        console.log(response.data);
    }

    async systemEndpoint() {
        const response = await axios.get(`${config.JELLYFIN_ENDPOINT}/System/Endpoint`, {
            headers: {
                'X-MediaBrowser-Token': config.JELLYFIN_API_KEY
            }
        });
        console.log(response.data);
    }
}